package logpipe

import (
	"io"
	"os"
)

// maxRead bounds one ReadLog call: a capped log plus its closing notes.
const maxRead = MaxLogBytes + 1<<10

// ReadLog returns the bytes of the log at path from offset to EOF, at most
// MaxLogBytes plus 1 KiB, and the offset to pass next time. A missing file
// returns an error that matches os.ErrNotExist.
func ReadLog(path string, offset int64) (data []byte, next int64, err error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, offset, err
	}
	defer f.Close()
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return nil, offset, err
	}
	data, err = io.ReadAll(io.LimitReader(f, maxRead))
	return data, offset + int64(len(data)), err
}
