// Command compose-app is the HTTP service of the compose-bluegreen
// integration fixture. Its failure modes are driven from outside:
// FAIL_HEALTH=1 fails /healthz, and the file /data/fail-after-start fails
// every request from the moment it exists.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

const failAfterStart = "/data/fail-after-start"

func main() {
	failHealth := os.Getenv("FAIL_HEALTH") == "1"

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		if failHealth {
			http.Error(w, "unhealthy: FAIL_HEALTH=1", http.StatusServiceUnavailable)
			return
		}
		fmt.Fprintln(w, "ok")
	})
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintf(w, "version=%s\n", version)
	})

	srv := &http.Server{Addr: ":8080", Handler: failAfter(mux), ReadHeaderTimeout: 5 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()
	drained := make(chan struct{})
	go func() {
		defer close(drained)
		<-ctx.Done()
		// Drain in-flight requests so a stopped color drops none.
		sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(sctx); err != nil {
			log.Printf("shutdown: %v", err)
		}
	}()
	log.Printf("compose-app %s listening on :8080", version)
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
	<-drained
}

// failAfter answers 500 to every request while failAfterStart exists.
func failAfter(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := os.Stat(failAfterStart); err == nil {
			http.Error(w, "failing: "+failAfterStart+" exists", http.StatusInternalServerError)
			return
		}
		next.ServeHTTP(w, r)
	})
}
