{{- define "agentrun.selectorLabels" -}}
app.kubernetes.io/name: agentrun
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "agentrun.labels" -}}
{{ include "agentrun.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end }}

{{- define "agentrun.image" -}}
{{ .Values.image.repository }}:{{ .Values.image.tag | default (printf "v%s" .Chart.AppVersion) }}
{{- end }}

{{- /* AGENTRUN_PUBLIC_URL, which the server's links use and NOTES prints: env.AGENTRUN_PUBLIC_URL, else the ingress's. */}}
{{- define "agentrun.publicUrl" -}}
{{- if .Values.env.AGENTRUN_PUBLIC_URL -}}
{{ .Values.env.AGENTRUN_PUBLIC_URL }}
{{- else if .Values.ingress.enabled -}}
{{ ternary "https" "http" (ne .Values.ingress.tlsSecret "") }}://{{ .Values.ingress.host }}/
{{- end -}}
{{- end }}
