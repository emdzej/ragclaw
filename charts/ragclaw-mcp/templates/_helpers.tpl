{{/*
Expand the name of the chart.
*/}}
{{- define "ragclaw-mcp.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this.
If release name contains chart name it will be used as a full name.
*/}}
{{- define "ragclaw-mcp.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "ragclaw-mcp.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "ragclaw-mcp.labels" -}}
helm.sh/chart: {{ include "ragclaw-mcp.chart" . }}
{{ include "ragclaw-mcp.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels.
*/}}
{{- define "ragclaw-mcp.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ragclaw-mcp.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use.
*/}}
{{- define "ragclaw-mcp.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "ragclaw-mcp.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Return the container image string.
*/}}
{{- define "ragclaw-mcp.image" -}}
{{- $tag := default .Chart.AppVersion .Values.image.tag -}}
{{- if .Values.image.registry -}}
{{- printf "%s/%s:%s" .Values.image.registry .Values.image.repository $tag }}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository $tag }}
{{- end -}}
{{- end }}

{{/*
Return the name of the ConfigMap to use for config.yaml.
*/}}
{{- define "ragclaw-mcp.configMapName" -}}
{{- if .Values.config.existingConfigMap }}
{{- .Values.config.existingConfigMap }}
{{- else }}
{{- include "ragclaw-mcp.fullname" . }}
{{- end }}
{{- end }}

{{/*
Return the name of the PVC to use for data.
*/}}
{{- define "ragclaw-mcp.pvcName" -}}
{{- if .Values.persistence.existingClaim }}
{{- .Values.persistence.existingClaim }}
{{- else }}
{{- include "ragclaw-mcp.fullname" . }}
{{- end }}
{{- end }}
