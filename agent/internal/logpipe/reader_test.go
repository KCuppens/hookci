package logpipe

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestReadLogOffset(t *testing.T) {
	path := filepath.Join(t.TempDir(), "job.log")
	if _, _, err := ReadLog(path, 0); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing file err = %v, want os.ErrNotExist", err)
	}

	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	var off int64
	for _, chunk := range []string{"first line\n", "second ", "half\n", ""} {
		if _, err := f.WriteString(chunk); err != nil {
			t.Fatal(err)
		}
		data, next, err := ReadLog(path, off)
		if err != nil {
			t.Fatal(err)
		}
		if string(data) != chunk {
			t.Errorf("ReadLog(%d) = %q, want %q", off, data, chunk)
		}
		if next != off+int64(len(chunk)) {
			t.Errorf("next = %d, want %d", next, off+int64(len(chunk)))
		}
		off = next
	}
}

func TestReadLogBounded(t *testing.T) {
	path := filepath.Join(t.TempDir(), "job.log")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(maxRead + 5); err != nil { // sparse
		t.Fatal(err)
	}
	f.Close()
	data, next, err := ReadLog(path, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) != maxRead || next != maxRead {
		t.Fatalf("ReadLog read %d bytes, next %d; want %d", len(data), next, maxRead)
	}
	if data, next, _ = ReadLog(path, next); len(data) != 5 || next != maxRead+5 {
		t.Errorf("second ReadLog read %d bytes, next %d; want the last 5", len(data), next)
	}
}
