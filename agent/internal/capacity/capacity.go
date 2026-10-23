// Package capacity admits check work against a CPU and memory budget and
// against the host's free memory and pressure, so runs going side by side
// stay within what the machine can spare next to whatever else it hosts.
//
// Work is admitted when nothing else holds the pool, so one setup or job at
// a time always makes progress. Past that, a demand must fit the budget's
// remainder and the host must have room for it right now.
//
// A demand's CPUs are its guaranteed minimum: the pool admits against the
// sum of them. CPU the budget leaves idle is lent to running jobs that
// allow it, up to their MaxCPUs, and taken back down to the minimum the
// moment other work needs room or the host comes under pressure. Memory is
// never lent. Nothing is ever killed: backing off stops admitting and
// shrinks grants, nothing more.
package capacity

import (
	"context"
	"fmt"
	"log/slog"
	"math"
	"runtime"
	"sync"
	"time"

	"github.com/KCuppens/hookci/agent/internal/clock"
)

// DefaultMemReserve is the memory the host keeps free past every admitted
// demand.
const DefaultMemReserve int64 = 4 << 30

// RecheckInterval is how often the pool samples the host: to wake refused
// work, since the host's free memory and pressure change without a Release,
// and to notice pressure so it can take lent CPU back.
const RecheckInterval = 5 * time.Second

// WholeBudget as a Demand's MaxCPUs lets the job be lent up to the whole CPU
// budget.
const WholeBudget = math.MaxFloat64

// epsilon is the CPU difference that counts as a change of grant.
const epsilon = 1e-9

// Demand is what one setup or job asks for: its CPU and memory limits, and
// which unit of work it is.
type Demand struct {
	// CPUs is the guaranteed minimum, in cores.
	CPUs float64
	// MaxCPUs is the most the job may be lent when the budget has idle CPU.
	// At or below CPUs, or 0, the job is never lent any.
	MaxCPUs     float64
	MemoryBytes int64
	// Run, Job and Lane say whom the grant belongs to, for Snapshot. Job is
	// empty for a run's setup.
	Run, Job, Lane string
}

// Sample is the host's state at one instant.
type Sample struct {
	MemTotal     int64   // bytes, as /proc/meminfo's MemTotal; 0 when unknown
	MemAvailable int64   // bytes, as /proc/meminfo's MemAvailable
	Load1        float64 // one-minute load average
	// PSI reports whether the kernel exposes pressure stall information;
	// CPUPressure and MemPressure are meaningful only then. Both are the
	// "some avg10" value in percent.
	PSI         bool
	CPUPressure float64
	MemPressure float64
}

// Host reads the machine's current free memory, load and pressure.
type Host interface {
	Sample() (Sample, error)
}

// Thresholds say when the host is too busy for more work. Each signal has a
// high mark that starts backing off and a low mark that ends it, so it does
// not flap around one number.
type Thresholds struct {
	CPUPressureHigh, CPUPressureLow float64 // PSI some avg10, percent
	MemPressureHigh, MemPressureLow float64 // PSI some avg10, percent
	// MemAvailableLow and MemAvailableHigh are fractions of the host's
	// memory: back off below the first, resume at or above the second.
	MemAvailableLow, MemAvailableHigh float64
}

// DefaultThresholds is what a zero Options.Thresholds means.
func DefaultThresholds() Thresholds {
	return Thresholds{
		CPUPressureHigh: 40, CPUPressureLow: 20,
		MemPressureHigh: 10, MemPressureLow: 3,
		MemAvailableLow: 0.10, MemAvailableHigh: 0.15,
	}
}

// enter is why s asks to back off, or "".
func (t Thresholds) enter(s Sample) string {
	switch {
	case s.PSI && s.CPUPressure > t.CPUPressureHigh:
		return fmt.Sprintf("cpu pressure %.1f%%", s.CPUPressure)
	case s.PSI && s.MemPressure > t.MemPressureHigh:
		return fmt.Sprintf("memory pressure %.1f%%", s.MemPressure)
	case s.MemTotal > 0 && float64(s.MemAvailable) < t.MemAvailableLow*float64(s.MemTotal):
		return fmt.Sprintf("%d MiB of %d MiB memory available", s.MemAvailable>>20, s.MemTotal>>20)
	}
	return ""
}

// leave reports whether every signal is back inside its low mark.
func (t Thresholds) leave(s Sample) bool {
	if s.PSI && (s.CPUPressure > t.CPUPressureLow || s.MemPressure > t.MemPressureLow) {
		return false
	}
	return s.MemTotal == 0 || float64(s.MemAvailable) >= t.MemAvailableHigh*float64(s.MemTotal)
}

// Options configure a Pool.
type Options struct {
	CPUs        float64      // budget in cores; <= 0 means none
	MemoryBytes int64        // budget in bytes; <= 0 means none
	Host        Host         // nil skips the live check
	CPUCount    int          // host cores; <= 0 means runtime.NumCPU()
	MemReserve  int64        // < 0 means none; 0 means DefaultMemReserve
	Thresholds  Thresholds   // zero means DefaultThresholds()
	Clock       clock.Clock  // nil means clock.Real
	Logger      *slog.Logger // nil discards
}

// Pool is the budget shared by every run of an agent.
type Pool struct {
	o       Options
	mu      sync.Mutex
	grants  []*Grant // admitted, in admission order
	refused bool     // a TryAcquire failed since the last recheck
	busy    string   // the last live refusal, logged once per change
	subs    map[uint64]func()
	nextSub uint64
	watches map[*watch]struct{}

	sample  Sample // the last successful one; meaningful when sampled
	sampled bool   // the last host sample succeeded
	failing bool   // the last host sample failed
	backing bool   // the host is under pressure
	backWhy string // why it is
}

// New returns a Pool with o's budget.
func New(o Options) *Pool {
	if o.CPUCount <= 0 {
		o.CPUCount = runtime.NumCPU()
	}
	switch {
	case o.MemReserve == 0:
		o.MemReserve = DefaultMemReserve
	case o.MemReserve < 0:
		o.MemReserve = 0
	}
	if o.Thresholds == (Thresholds{}) {
		o.Thresholds = DefaultThresholds()
	}
	if o.Clock == nil {
		o.Clock = clock.Real{}
	}
	if o.Logger == nil {
		o.Logger = slog.New(slog.DiscardHandler)
	}
	return &Pool{o: o, subs: map[uint64]func(){}, watches: map[*watch]struct{}{}}
}

// Grant is an admitted demand's share. Release it when the work is done.
type Grant struct {
	p        *Pool
	d        Demand
	cpus     float64
	ch       chan float64
	released bool
}

// CPUs is the cores granted now: at least the demand's CPUs, more while the
// budget has idle CPU to lend.
func (g *Grant) CPUs() float64 {
	g.p.mu.Lock()
	defer g.p.mu.Unlock()
	return g.cpus
}

// Changed delivers the new CPU grant each time it changes. It holds only the
// latest value, so a slow reader sees the newest grant, not every step.
func (g *Grant) Changed() <-chan float64 { return g.ch }

// Release returns the share to the pool and wakes every subscriber. It is
// idempotent.
func (g *Grant) Release() {
	p := g.p
	p.mu.Lock()
	if g.released {
		p.mu.Unlock()
		return
	}
	g.released = true
	for i, x := range p.grants {
		if x == g {
			p.grants = append(p.grants[:i], p.grants[i+1:]...)
			break
		}
	}
	p.settle()
	wake := p.subscribers()
	p.mu.Unlock()
	for _, fn := range wake {
		fn()
	}
}

func (g *Grant) push(v float64) {
	select {
	case <-g.ch:
	default:
	}
	g.ch <- v
}

type grantKey struct{}

// WithGrant carries g to whoever runs the work it was admitted for.
func WithGrant(ctx context.Context, g *Grant) context.Context {
	return context.WithValue(ctx, grantKey{}, g)
}

// GrantFrom is the grant WithGrant stored, or nil.
func GrantFrom(ctx context.Context) *Grant {
	g, _ := ctx.Value(grantKey{}).(*Grant)
	return g
}

// TryAcquire admits d when it fits, and returns its grant, which holds the
// share until Release. It reports false when d does not fit. With nothing
// held d is always admitted, but the host is sampled all the same so the
// grants know whether CPU can be lent.
func (p *Pool) TryAcquire(d Demand) (*Grant, bool) {
	d.CPUs = max(d.CPUs, 0)
	d.MemoryBytes = max(d.MemoryBytes, 0)
	p.mu.Lock()
	held := len(p.grants) > 0
	fits := !held || p.fitsBudget(d)
	var busy string
	var cleared bool
	if fits {
		busy, cleared = p.hostBusy(d)
		if held {
			p.note(busy)
		}
	}
	if held && (!fits || busy != "") {
		p.refused = true
		wake := p.wakeIf(cleared)
		p.mu.Unlock()
		call(wake)
		return nil, false
	}
	g := &Grant{p: p, d: d, cpus: d.CPUs, ch: make(chan float64, 1)}
	p.grants = append(p.grants, g)
	p.settle()
	wake := p.wakeIf(cleared)
	p.mu.Unlock()
	call(wake)
	return g, true
}

// SetBudget replaces the budget; <= 0 means none. Grants are rebalanced to
// it at once, and refused work is woken since more may fit now. Work already
// admitted keeps running whatever the new budget.
func (p *Pool) SetBudget(cpus float64, memoryBytes int64) {
	p.mu.Lock()
	if cpus == p.o.CPUs && memoryBytes == p.o.MemoryBytes {
		p.mu.Unlock()
		return
	}
	p.o.CPUs, p.o.MemoryBytes = cpus, memoryBytes
	p.settle()
	wake := p.subscribers()
	p.mu.Unlock()
	call(wake)
}

// Subscribe calls wake whenever refused work may now fit: on every Release
// and on rechecks. wake must not block. The returned func unsubscribes.
func (p *Pool) Subscribe(wake func()) func() {
	p.mu.Lock()
	defer p.mu.Unlock()
	id := p.nextSub
	p.nextSub++
	p.subs[id] = wake
	return func() {
		p.mu.Lock()
		delete(p.subs, id)
		p.mu.Unlock()
	}
}

// JobGrant is one admitted setup's or job's share.
type JobGrant struct {
	Run, Job, Lane string // Job is empty for a run's setup
	MinCPUs        float64
	GrantedCPUs    float64
	MemoryBytes    int64
}

// Snapshot is the pool's state at one instant. Pressure fields are -1 when
// the host does not report them; MemAvailableBytes and HostMemoryBytes are 0
// when unknown.
type Snapshot struct {
	HostCPUs            float64
	HostMemoryBytes     int64
	BudgetCPUs          float64
	BudgetMemoryBytes   int64 // 0: no memory budget
	GrantedCPUs         float64
	ReservedMemoryBytes int64
	MemAvailableBytes   int64
	CPUPressure         float64
	MemPressure         float64
	BackingOff          bool
	Jobs                []JobGrant
}

// Snapshot reports the current state.
func (p *Pool) Snapshot() Snapshot {
	p.mu.Lock()
	defer p.mu.Unlock()
	s := Snapshot{
		HostCPUs:          float64(p.o.CPUCount),
		HostMemoryBytes:   p.sample.MemTotal,
		BudgetCPUs:        p.budgetCPUs(),
		BudgetMemoryBytes: max(p.o.MemoryBytes, 0),
		MemAvailableBytes: p.sample.MemAvailable,
		CPUPressure:       -1,
		MemPressure:       -1,
		BackingOff:        p.backing,
		Jobs:              make([]JobGrant, 0, len(p.grants)),
	}
	if p.sampled && p.sample.PSI {
		s.CPUPressure, s.MemPressure = p.sample.CPUPressure, p.sample.MemPressure
	}
	for _, g := range p.grants {
		s.GrantedCPUs += g.cpus
		s.ReservedMemoryBytes += g.d.MemoryBytes
		s.Jobs = append(s.Jobs, JobGrant{Run: g.d.Run, Job: g.d.Job, Lane: g.d.Lane, MinCPUs: g.d.CPUs, GrantedCPUs: g.cpus, MemoryBytes: g.d.MemoryBytes})
	}
	return s
}

type watch struct {
	kick chan struct{}
	done chan struct{}
}

// Watch calls fn with the pool's Snapshot after every change to it: a
// grant, a release, a rebalance, a backoff change, a new budget. Calls are
// coalesced, so a burst of changes yields one call with the latest Snapshot,
// and run on a goroutine of their own, so fn may call back into the Pool.
// The returned func stops delivery.
func (p *Pool) Watch(fn func(Snapshot)) (cancel func()) {
	w := &watch{kick: make(chan struct{}, 1), done: make(chan struct{})}
	p.mu.Lock()
	p.watches[w] = struct{}{}
	p.mu.Unlock()
	go func() {
		for {
			select {
			case <-w.done:
				return
			case <-w.kick:
				fn(p.Snapshot())
			}
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() {
			p.mu.Lock()
			delete(p.watches, w)
			p.mu.Unlock()
			close(w.done)
		})
	}
}

// notify kicks every watch. p.mu must be held.
func (p *Pool) notify() {
	for w := range p.watches {
		select {
		case w.kick <- struct{}{}:
		default:
		}
	}
}

// Run samples the host every RecheckInterval until ctx ends: it backs off and
// resumes as pressure crosses the thresholds, and wakes the subscribers
// after a refusal or when backing off ends.
func (p *Pool) Run(ctx context.Context) {
	t := p.o.Clock.NewTicker(RecheckInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C():
		}
		var s Sample
		var err error
		if p.o.Host != nil {
			s, err = p.o.Host.Sample()
		}
		p.mu.Lock()
		cleared := false
		if p.o.Host != nil {
			cleared = p.observe(s, err)
		}
		wake := p.wakeIf(p.refused || cleared)
		p.refused = false
		p.mu.Unlock()
		call(wake)
	}
}

// wakeIf returns the subscribers to wake when cond holds, else nil. p.mu
// must be held.
func (p *Pool) wakeIf(cond bool) []func() {
	if !cond {
		return nil
	}
	return p.subscribers()
}

func call(fns []func()) {
	for _, fn := range fns {
		fn()
	}
}

// subscribers returns the wake funcs. p.mu must be held.
func (p *Pool) subscribers() []func() {
	out := make([]func(), 0, len(p.subs))
	for _, fn := range p.subs {
		out = append(out, fn)
	}
	return out
}

// budgetCPUs is the CPU budget, the host's cores when there is none.
// p.mu must be held.
func (p *Pool) budgetCPUs() float64 {
	if p.o.CPUs > 0 {
		return p.o.CPUs
	}
	return float64(p.o.CPUCount)
}

// fitsBudget reports whether d fits the rest of the budget. p.mu must be
// held.
func (p *Pool) fitsBudget(d Demand) bool {
	var cpus float64
	var mem int64
	for _, g := range p.grants {
		cpus += g.d.CPUs
		mem += g.d.MemoryBytes
	}
	if p.o.CPUs > 0 && cpus+d.CPUs > p.o.CPUs {
		return false
	}
	if p.o.MemoryBytes > 0 && mem+d.MemoryBytes > p.o.MemoryBytes {
		return false
	}
	return true
}

// hostBusy samples the host and says why it cannot take d now, or "": d's
// memory plus the reserve is not available, it is under pressure, or without
// pressure information its load reaches the CPU count. A failed sample is not
// busy. cleared reports that the sample ended a backoff. p.mu must be held.
func (p *Pool) hostBusy(d Demand) (busy string, cleared bool) {
	if p.o.Host == nil {
		return "", false
	}
	s, err := p.o.Host.Sample()
	cleared = p.observe(s, err)
	if err != nil {
		return "", cleared
	}
	switch {
	case s.MemAvailable-d.MemoryBytes < p.o.MemReserve:
		busy = fmt.Sprintf("%d MiB available, work needs %d MiB plus %d MiB reserve",
			s.MemAvailable>>20, d.MemoryBytes>>20, p.o.MemReserve>>20)
	case p.backing:
		busy = "backing off: " + p.backWhy
	case !s.PSI && s.Load1 >= float64(p.o.CPUCount):
		busy = fmt.Sprintf("load %.2f on %d CPUs", s.Load1, p.o.CPUCount)
	}
	return busy, cleared
}

// observe takes the outcome of a host sample: it enters or leaves backing off
// and rebalances when the grants could change. It reports whether a backoff
// ended. p.mu must be held.
func (p *Pool) observe(s Sample, err error) (cleared bool) {
	if err != nil {
		if !p.failing {
			p.failing = true
			p.o.Logger.Warn("host sample failed; admitting by budget only", "err", err)
		}
		if p.sampled {
			p.sampled = false
			p.settle()
		}
		return false
	}
	p.failing = false
	wasLending := p.lending()
	p.sample, p.sampled = s, true
	switch {
	case !p.backing:
		if why := p.o.Thresholds.enter(s); why != "" {
			p.backing, p.backWhy = true, why
			p.o.Logger.Warn("host under pressure; holding new work and taking lent CPU back", "why", why)
			p.settle()
			return false
		}
	case p.o.Thresholds.leave(s):
		p.backing = false
		p.o.Logger.Info("pressure cleared; admitting work again")
		p.settle()
		return true
	}
	if p.lending() != wasLending {
		p.settle()
	}
	return false
}

// lending reports whether idle CPU may be lent: only while a pressure signal
// says the host would tell us to take it back. p.mu must be held.
func (p *Pool) lending() bool {
	return p.sampled && p.sample.PSI && !p.backing
}

// note logs busy when it differs from the last one. p.mu must be held.
func (p *Pool) note(busy string) {
	if busy == p.busy {
		return
	}
	p.busy = busy
	if busy != "" {
		p.o.Logger.Info("host busy; holding new work", "why", busy)
	}
}

// settle rebalances the grants and tells the watchers. p.mu must be held.
func (p *Pool) settle() {
	p.rebalance()
	p.notify()
}

// rebalance gives every grant its minimum, then splits what is left of the
// CPU budget evenly among grants that may be lent more, each up to its
// ceiling. Nobody is lent anything while the host is under pressure or gives
// no pressure information, or when the minimums already fill the budget.
// p.mu must be held.
func (p *Pool) rebalance() {
	if len(p.grants) == 0 {
		return
	}
	budget := p.budgetCPUs()
	want := make([]float64, len(p.grants))
	spare := budget
	for i, g := range p.grants {
		want[i] = g.d.CPUs
		spare -= g.d.CPUs
	}
	if !p.lending() {
		spare = 0
	}
	open := make([]int, 0, len(p.grants))
	for i, g := range p.grants {
		if ceiling(g.d, budget) > want[i]+epsilon {
			open = append(open, i)
		}
	}
	for spare > epsilon && len(open) > 0 {
		share := spare / float64(len(open))
		next := open[:0:0]
		for _, i := range open {
			room := ceiling(p.grants[i].d, budget) - want[i]
			give := math.Min(share, room)
			want[i] += give
			spare -= give
			if room-give > epsilon {
				next = append(next, i)
			}
		}
		open = next
	}
	for i, g := range p.grants {
		if math.Abs(want[i]-g.cpus) > epsilon {
			g.cpus = want[i]
			g.push(want[i])
		}
	}
}

// ceiling is the most CPU a demand may be lent: never below its minimum.
func ceiling(d Demand, budget float64) float64 {
	return math.Max(math.Min(d.MaxCPUs, budget), d.CPUs)
}
