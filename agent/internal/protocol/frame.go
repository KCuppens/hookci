// Package protocol holds the agent to hub WebSocket messages generated from
// schema/hookci.schema.json ($defs.protocol) and the frame helpers around them.
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

// frameType is how DecodeFrame handles one frame type: the decoder into its
// generated message, and the message's required fields other than v and
// type, which PeekType checks.
type frameType struct {
	decode   func(frame []byte) (any, error)
	required []string
}

var frameTypes = map[string]frameType{
	"hello":         {decodeAs[Hello], []string{"protocol_version", "agent_version"}},
	"trigger":       {decodeAs[Trigger], []string{"hub_seq", "trigger_id", "repo", "sha", "ref", "event", "attempt", "trust"}},
	"accepted":      {decodeAs[Accepted], []string{"trigger_id", "run_id"}},
	"rejected":      {decodeAs[Rejected], []string{"trigger_id", "reason"}},
	"job_planned":   {decodeAs[JobPlanned], []string{"run_id", "jobs"}},
	"event":         {decodeAs[Event], []string{"agent_seq", "run_id", "state"}},
	"annotations":   {decodeAs[Annotations], []string{"agent_seq", "run_id", "job", "items"}},
	"token_request": {decodeAs[TokenRequest], []string{"run_id", "purpose"}},
	"token":         {decodeAs[Token], []string{"run_id", "token", "exp"}},
	"log_subscribe": {decodeAs[LogSubscribe], []string{"run_id"}},
	"log":           {decodeAs[Log], []string{"run_id", "job", "offset", "bytes"}},
	"ack":           {decodeAs[Ack], []string{"upto"}},
	"welcome":       {decodeAs[Welcome], []string{"hub_version", "protocol_min", "protocol_max", "agent_id", "installation_id"}},
	"interrupt":     {decodeAs[Interrupt], []string{"reason"}},
	"error":         {decodeAs[Error], []string{"code", "message"}},
}

// DecodeFrame checks the frame's version, type and required fields and
// returns it decoded, by value, into the generated message for its type:
// Hello, Trigger, Accepted, Rejected, JobPlanned, Event, Annotations,
// TokenRequest, Token, LogSubscribe, Log, Ack, Welcome, Interrupt or Error.
// An interrupt must carry exactly one of run_id or trigger_id. Unknown
// fields are ignored so a newer peer can add optional fields.
func DecodeFrame(frame []byte) (any, error) {
	typ, err := PeekType(frame)
	if err != nil {
		return nil, err
	}
	ft, ok := frameTypes[typ]
	if !ok {
		return nil, fmt.Errorf("protocol: unknown frame type %q", typ)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(frame, &fields); err != nil {
		return nil, fmt.Errorf("protocol: decode %s: %w", typ, err)
	}
	for _, key := range ft.required {
		if _, ok := fields[key]; !ok {
			return nil, fmt.Errorf("protocol: %s frame lacks %s", typ, key)
		}
	}
	if typ == "interrupt" {
		_, hasRun := fields["run_id"]
		_, hasTrigger := fields["trigger_id"]
		if hasRun == hasTrigger {
			return nil, errors.New("protocol: interrupt frame needs exactly one of run_id or trigger_id")
		}
	}
	msg, err := ft.decode(frame)
	if err != nil {
		return nil, fmt.Errorf("protocol: decode %s: %w", typ, err)
	}
	return msg, nil
}

// decodeAs decodes frame into a T, returning nil rather than a zero T on error.
func decodeAs[T any](frame []byte) (any, error) {
	var msg T
	if err := json.Unmarshal(frame, &msg); err != nil {
		return nil, err
	}
	return msg, nil
}
