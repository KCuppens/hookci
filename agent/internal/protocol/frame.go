// Package protocol holds the agent to hub WebSocket messages generated from
// schema/zeroci.schema.json ($defs.protocol) and the frame helpers around them.
// Envelope is generated into types_gen.go from $defs.protocol.Envelope.
package protocol

import (
	"encoding/json"
	"errors"
	"fmt"
)

// Version is the protocol version carried in every frame's v field.
const Version = 1

// Marshal encodes msg as a frame, setting v to Version and type to msgType.
// msg must encode to a JSON object.
func Marshal(msgType string, msg any) ([]byte, error) {
	body, err := json.Marshal(msg)
	if err != nil {
		return nil, fmt.Errorf("protocol: marshal %s: %w", msgType, err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		return nil, fmt.Errorf("protocol: %s does not encode to a JSON object: %w", msgType, err)
	}
	if fields == nil {
		return nil, fmt.Errorf("protocol: %s encodes to null", msgType)
	}
	typ, err := json.Marshal(msgType)
	if err != nil {
		return nil, fmt.Errorf("protocol: marshal type %q: %w", msgType, err)
	}
	fields["v"] = json.RawMessage(`1`)
	fields["type"] = typ
	return json.Marshal(fields)
}

// PeekType returns the frame's type after checking that v equals Version.
func PeekType(frame []byte) (string, error) {
	var env Envelope
	if err := json.Unmarshal(frame, &env); err != nil {
		return "", fmt.Errorf("protocol: decode envelope: %w", err)
	}
	if env.V != Version {
		return "", fmt.Errorf("protocol: unsupported version %d, want %d", env.V, Version)
	}
	if env.Type == "" {
		return "", errors.New("protocol: frame has no type")
	}
	return env.Type, nil
}

// Unmarshal checks the frame's version and decodes it into out.
func Unmarshal(frame []byte, out any) error {
	if _, err := PeekType(frame); err != nil {
		return err
	}
	if err := json.Unmarshal(frame, out); err != nil {
		return fmt.Errorf("protocol: decode frame: %w", err)
	}
	return nil
}
