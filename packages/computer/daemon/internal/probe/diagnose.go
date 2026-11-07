package probe

import "time"

// Check is one diagnostic attempt. Red: the shape only.
type Check struct {
	Probe   string
	Address string
	Name    string
}

// Bounds bounds a diagnosis.
type Bounds struct {
	Connect time.Duration
	Read    time.Duration
	Whole   time.Duration
	MaxRead int
}

// DiagnoseBounds are the diagnostic's own bounds.
var DiagnoseBounds = Bounds{}

// Outcome is one check's result.
type Outcome struct {
	Target  string `json:"target"`
	Port    int    `json:"port"`
	Proto   string `json:"proto"`
	Probe   string `json:"probe"`
	Name    string `json:"name,omitempty"`
	Outcome string `json:"outcome"`
	Bytes   int    `json:"bytes"`
	Detail  string `json:"detail"`
}

// Diagnosis is the diagnostic's report.
type Diagnosis struct {
	UID     int       `json:"uid"`
	GID     int       `json:"gid"`
	Kernel  string    `json:"kernel"`
	Verdict string    `json:"verdict"`
	Results []Outcome `json:"results"`
}

// DiagnoseChecks is not written yet.
func DiagnoseChecks() []Check { return nil }

// Diagnose is not written yet.
func Diagnose(checks []Check, bounds Bounds) Diagnosis { return Diagnosis{} }
