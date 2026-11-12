// The desktop fixture on Windows, where computerd-fixture (an X11 binary) cannot run: a PowerShell script that makes the
// same window (200x200 at (0, 0), borderless, on top, in the four FIXTURE_COLORS by quadrant) with Windows Forms, and
// logs what it gets as computerd-fixture does, one JSON object a line (FixtureEvent), to the file its argument names.
// Its ready line also carries its pid, which the case stops it by. It runs in a single-threaded apartment (-STA), as
// Windows Forms needs. UTF-8 with no byte order mark, so the log's first line parses as the rest do.
export const WINDOWS_FIXTURE = [
	"# agentrun-computer: windows-fixture",
	"param([Parameter(Mandatory = $true)][string]$Log)",
	"$ErrorActionPreference = 'Stop'",
	"Add-Type -AssemblyName System.Windows.Forms, System.Drawing",
	"$utf8 = New-Object System.Text.UTF8Encoding($false)",
	"function Say($o) { [IO.File]::AppendAllText($Log, ($o | ConvertTo-Json -Compress) + \"`n\", $utf8) }",
	"function ButtonOf($b) { switch ($b) { 'Right' { 'right' } 'Middle' { 'middle' } default { 'left' } } }",
	"$f = New-Object System.Windows.Forms.Form",
	"$f.FormBorderStyle = 'None'",
	"$f.StartPosition = 'Manual'",
	"$f.Location = New-Object System.Drawing.Point(0, 0)",
	"$f.ClientSize = New-Object System.Drawing.Size(200, 200)",
	"$f.TopMost = $true",
	"$f.ShowInTaskbar = $false",
	"$f.KeyPreview = $true",
	"$f.add_Paint({",
	"  param($s, $e)",
	"  $e.Graphics.FillRectangle([System.Drawing.Brushes]::Red, 0, 0, 100, 100)",
	"  $e.Graphics.FillRectangle((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(0, 255, 0))), 100, 0, 100, 100)",
	"  $e.Graphics.FillRectangle((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(0, 0, 255))), 0, 100, 100, 100)",
	"  $e.Graphics.FillRectangle((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 0))), 100, 100, 100, 100)",
	"})",
	"$f.add_MouseDown({ param($s, $e) Say @{ event = 'down'; button = (ButtonOf $e.Button); at = @($e.X, $e.Y) } })",
	"$f.add_MouseUp({ param($s, $e) Say @{ event = 'up'; button = (ButtonOf $e.Button); at = @($e.X, $e.Y) } })",
	"$f.add_MouseWheel({ param($s, $e) Say @{ event = 'wheel'; at = @($e.X, $e.Y); dx = 0; dy = [int](-$e.Delta / 120) } })",
	"$f.add_KeyDown({ param($s, $e) Say @{ event = 'key'; key = $e.KeyCode.ToString().ToLower(); down = $true } })",
	"$f.add_KeyUp({ param($s, $e) Say @{ event = 'key'; key = $e.KeyCode.ToString().ToLower(); down = $false } })",
	"$f.add_KeyPress({ param($s, $e) if (-not [char]::IsControl($e.KeyChar)) { Say @{ event = 'text'; text = [string]$e.KeyChar } } })",
	"$f.add_Shown({ $f.Activate(); Say @{ event = 'ready'; pid = $PID } })",
	"[System.Windows.Forms.Application]::Run($f)",
].join("\r\n");
