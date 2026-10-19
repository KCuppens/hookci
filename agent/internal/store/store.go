package store

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

// DB wraps an embedded SQLite database configured with WAL mode and pragmas
// suitable for the zeroci agent.
type DB struct {
	sql *sql.DB
}

// Open initializes or opens the SQLite database at dbPath. If directories do not exist,
// they are created with 0o755. It enables WAL journal mode, sets busy_timeout, foreign keys,
// and runs schema migrations.
func Open(ctx context.Context, dbPath string) (*DB, error) {
	if dbPath != ":memory:" && !filepath.IsAbs(dbPath) {
		abs, err := filepath.Abs(dbPath)
		if err != nil {
			return nil, fmt.Errorf("resolve db path: %w", err)
		}
		dbPath = abs
	}

	if dbPath != ":memory:" {
		dir := filepath.Dir(dbPath)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("create db directory %s: %w", dir, err)
		}
	}

	// SQLite connection string with pragmas
	dsn := fmt.Sprintf("%s?_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)", dbPath)
	if dbPath != ":memory:" {
		dsn += "&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)"
	}

	conn, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite db: %w", err)
	}

	// Single writer connection constraint or connection pool tuning for SQLite
	conn.SetMaxOpenConns(1)

	db := &DB{sql: conn}
	if err := db.migrate(ctx); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("run migrations: %w", err)
	}

	return db, nil
}

// Close closes the underlying SQLite database connection.
func (db *DB) Close() error {
	if db == nil || db.sql == nil {
		return nil
	}
	return db.sql.Close()
}

// Ping verifies a connection to the database.
func (db *DB) Ping(ctx context.Context) error {
	return db.sql.PingContext(ctx)
}
