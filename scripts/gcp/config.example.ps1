# ---------------------------------------------------------------------------
# Deployment parameters for scripts/gcp/*.ps1  -  PLACEHOLDERS ONLY.
#
#   1. Copy this file to `config.ps1`  (git-ignored, one per operator/CI box)
#   2. Replace YOUR_* with real values
#
# Every key can also be supplied per run as a script parameter
# (-ProjectId, -Region, -Service, -Repository, -Image) or through an
# environment variable:
#
#   VECTOR_GCP_PROJECT  VECTOR_GCP_REGION   VECTOR_GCP_SERVICE
#   VECTOR_GCP_REPOSITORY  VECTOR_GCP_IMAGE VECTOR_GCP_BUILDER
#   VECTOR_FIREBASE_SITE
#
# Precedence:  script parameter  >  environment variable  >  this file  >  default
#
# No secrets live here. JWT_SECRET and the mail credentials are read from
# Google Secret Manager by Cloud Run, never from this repository.
# ---------------------------------------------------------------------------

return @{
    # --- GCP -----------------------------------------------------------------
    ProjectId  = "YOUR_GCP_PROJECT_ID"
    Region     = "asia-south1"
    Service    = "vector-app"

    # --- Artifact Registry ---------------------------------------------------
    # Repository lives at  REGION-docker.pkg.dev/PROJECT/REPOSITORY
    Repository = "vector-prod"
    Image      = "vector-api"

    # --- How the image gets built -------------------------------------------
    #   docker     : local `docker build` + `docker push` (Docker Desktop must
    #                be running, and it must be able to reach REGION-docker.pkg.dev)
    #   cloudbuild : `gcloud builds submit --tag` (no local Docker required)
    Builder    = "docker"

    # --- Source context for the image build ---------------------------------
    # Leave empty to use <repo root>/backend
    Source     = ""

    # --- Firebase Hosting ----------------------------------------------------
    # Default Hosting site id; equals the Firebase project id for the default
    # site. Used by scripts/firebase/promote-live.ps1 and rollback-live.ps1.
    SiteId     = ""
}
