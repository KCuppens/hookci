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
