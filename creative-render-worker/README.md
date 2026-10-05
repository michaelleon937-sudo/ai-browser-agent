# Self-hosted Creative Render Worker

Runs the free/local 3D renderer with a Blender installation supplied by the host.

## Endpoints

- GET /healthz
- POST /render/3d

POST /render/3d requires an Authorization header:

Bearer RENDER_WORKER_TOKEN

Example JSON body:

{
  "project": {
    "name": "Luxury Product",
    "type": "3d",
    "spec": {
      "title": "Luxury Product",
      "description": "Hero product visual"
    }
  }
}

Required environment:
- BLENDER_BIN — absolute Blender executable path
- RENDER_WORKER_TOKEN — required secret
- RENDER_OUTPUT_DIR — optional, defaults to /data/renders
- RENDER_WORKER_PORT — optional, defaults to 8090

The worker is intentionally not deployed automatically. It is a self-hosted execution target for the feature branch and must pass environment/smoke verification before production use.
