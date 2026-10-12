# ---------------------------------------------------------------------------
# Deployment parameters for scripts/firebase/*.ps1  -  PLACEHOLDERS ONLY.
#
#   1. Copy this file to `config.ps1`  (git-ignored)
#   2. Replace YOUR_* with real values
#
# Every key can also be given per run as a script parameter, or through an
# environment variable:
#
#   VECTOR_GCP_PROJECT   VECTOR_FIREBASE_SITE
#   REACT_APP_API_BASE_URL   REACT_APP_WS_BASE_URL
#
# Precedence: script parameter > environment variable > this file > default
#
# No secrets belong here. The frontend only ever receives public URLs, which
# are inlined into the bundle at build time.
# ---------------------------------------------------------------------------

return @{
    # Firebase project / default Hosting site id.
    ProjectId  = "YOUR_GCP_PROJECT_ID"
    SiteId     = ""

    # Stable backend URL baked into the bundle. Always the Cloud Run service
    # URL (or a custom API domain) - NEVER a revision-specific URL, because
    # that URL disappears on the next deploy.
    #   gcloud run services describe vector-app --region asia-south1 \
    #     --format='value(status.url)'
    ApiBaseUrl = "https://YOUR_CLOUD_RUN_SERVICE_URL"

    # Optional. Leave empty to derive it from ApiBaseUrl (what production
    # wants). Only set it when /ws must live somewhere else, e.g. a dedicated
    # API domain in front of Cloud Run.
    WsBaseUrl  = ""

    # How long a preview channel stays alive (max 30d).
    ChannelTtl = "7d"
}
