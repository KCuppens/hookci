package logpipe

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/redact"
)

// Annotation captures an inline diagnostic annotation parsed from command output.
type Annotation struct {
	Level   string `json:"level"` // "error", "warning", "notice"
	File    string `json:"file,omitempty"`
	Line    int    `json:"line,omitempty"`
	Message string `json:"message"`
}

// Step captures a logical execution step within a job log.
type Step struct {
	Name      string    `json:"name"`
	StartedAt time.Time `json:"started_at"`
	EndedAt   time.Time `json:"ended_at,omitempty"`
	Status    string    `json:"status"` // "running", "success", "failure"
}

// Pipe manages the file logging, line-by-line redaction, live tailing,
// and step/annotation extraction for a single job execution.
type Pipe struct {
	Path     string
	redactor *redact.Redactor
	file     *os.File

	mu          sync.Mutex
	buf         bytes.Buffer
	subscribers []chan string
	annotations []Annotation
	steps       []*Step
	currentStep *Step
}

// LogPath computes the canonical log path: <state>/runs/<runID>/logs/<job>.log
func LogPath(stateDir, runID, job string) string {
	return filepath.Join(stateDir, "runs", runID, "logs", job+".log")
}

// New opens or creates the log file at path, ensuring parent directories exist.
func New(path string, redactor *redact.Redactor) (*Pipe, error) {
	if redactor == nil {
		redactor = redact.New()
	}

	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return nil, fmt.Errorf("mkdir log dir %s: %w", filepath.Dir(path), err)
	}

	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return nil, fmt.Errorf("open log file %s: %w", path, err)
	}

	return &Pipe{
		Path:     path,
		redactor: redactor,
		file:     f,
	}, nil
}

// Write processes incoming log chunks, splitting lines, applying redactions,
// parsing workflow step / annotation markers, writing to disk, and broadcasting.
func (p *Pipe) Write(data []byte) (n int, err error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	total := len(data)
	for len(data) > 0 {
		idx := bytes.IndexByte(data, '\n')
		if idx == -1 {
			p.buf.Write(data)
			break
		}

		p.buf.Write(data[:idx+1])
		line := p.buf.String()
		p.buf.Reset()

		p.processLine(line)
		data = data[idx+1:]
	}

	return total, nil
}

func (p *Pipe) processLine(rawLine string) {
	// 1. Redact line before anything else
	redacted := p.redactor.Redact(rawLine)

	// 2. Parse annotations or steps from the line
	trimmed := strings.TrimRight(redacted, "\r\n")
	p.parseMarkers(trimmed)

	// 3. Write directly to disk
	_, _ = p.file.WriteString(redacted)

	// 4. Broadcast line to active tail subscribers
	for _, ch := range p.subscribers {
		select {
		case ch <- redacted:
		default:
			// Non-blocking drop if consumer buffer is full
		}
	}
}

// parseMarkers inspects lines for workflow commands:
// ::step::start::<name>
// ::step::end::<status>
// ::error file=<path>,line=<n>::<message>
// ::warning file=<path>,line=<n>::<message>
// ::notice file=<path>,line=<n>::<message>
func (p *Pipe) parseMarkers(line string) {
	if !strings.HasPrefix(line, "::") {
		return
	}
	parts := strings.SplitN(line[2:], "::", 2)
	if len(parts) < 2 {
		return
	}

	command := parts[0]
	rest := parts[1]

	switch {
	case command == "step":
		sub := strings.SplitN(rest, "::", 2)
		action := sub[0]
		val := ""
		if len(sub) > 1 {
			val = sub[1]
		}
		if action == "start" {
			step := &Step{
				Name:      val,
				StartedAt: time.Now(),
				Status:    "running",
			}
			p.currentStep = step
			p.steps = append(p.steps, step)
		} else if action == "end" {
			status := val
			if status == "" {
				status = "success"
			}
			if p.currentStep != nil {
				p.currentStep.EndedAt = time.Now()
				p.currentStep.Status = status
				p.currentStep = nil
			}
		}

	case command == "error" || command == "warning" || command == "notice" ||
		strings.HasPrefix(command, "error ") || strings.HasPrefix(command, "warning ") || strings.HasPrefix(command, "notice "):
		level := strings.Fields(command)[0]
		ann := Annotation{
			Level:   level,
			Message: rest,
		}

		if strings.Contains(command, " ") {
			params := strings.TrimSpace(command[len(level):])
			for _, param := range strings.Split(params, ",") {
				kv := strings.SplitN(param, "=", 2)
				if len(kv) == 2 {
					k, v := strings.TrimSpace(kv[0]), strings.TrimSpace(kv[1])
					switch k {
					case "file":
						ann.File = v
					case "line":
						if l, err := strconv.Atoi(v); err == nil {
							ann.Line = l
						}
					}
				}
			}
		}

		p.annotations = append(p.annotations, ann)
	}
}

// Subscribe returns a channel receiving redacted log lines in real time.
func (p *Pipe) Subscribe(bufferSize int) <-chan string {
	p.mu.Lock()
	defer p.mu.Unlock()

	ch := make(chan string, bufferSize)
	p.subscribers = append(p.subscribers, ch)
	return ch
}

// Annotations returns all parsed diagnostic annotations.
func (p *Pipe) Annotations() []Annotation {
	p.mu.Lock()
	defer p.mu.Unlock()

	res := make([]Annotation, len(p.annotations))
	copy(res, p.annotations)
	return res
}

// Steps returns all tracked execution steps.
func (p *Pipe) Steps() []Step {
	p.mu.Lock()
	defer p.mu.Unlock()

	res := make([]Step, 0, len(p.steps))
	for _, s := range p.steps {
		res = append(res, *s)
	}
	return res
}

// Close flushes remaining buffers, closes the log file, and closes subscribers.
func (p *Pipe) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.buf.Len() > 0 {
		line := p.buf.String()
		p.buf.Reset()
		p.processLine(line)
	}

	for _, ch := range p.subscribers {
		close(ch)
	}
	p.subscribers = nil

	if p.file != nil {
		err := p.file.Close()
		p.file = nil
		return err
	}
	return nil
}

// TailFile reads an existing log file from disk line by line, optionally following.
func TailFile(ctx context.Context, path string) (<-chan string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open log file %s: %w", path, err)
	}

	ch := make(chan string, 100)
	go func() {
		defer close(ch)
		defer f.Close()

		reader := bufio.NewReader(f)
		for {
			select {
			case <-ctx.Done():
				return
			default:
			}

			line, err := reader.ReadString('\n')
			if len(line) > 0 {
				select {
				case ch <- line:
				case <-ctx.Done():
					return
				}
			}

			if err != nil {
				if err == io.EOF {
					// Wait briefly for more output or exit if context done
					time.Sleep(50 * time.Millisecond)
					continue
				}
				return
			}
		}
	}()

	return ch, nil
}
