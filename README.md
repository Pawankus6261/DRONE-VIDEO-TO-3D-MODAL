# Dex: Video-to-3D Reconstruction Platform

Turn 2D videos into interactive 3D reconstructions using state-of-the-art photogrammetry techniques, Neural Radiance Fields (NeRF), and Gaussian Splatting. This repo contains a full-stack application:

- Frontend: React app with Auth0 authentication and a project workflow UI
- Backend: Express.js API integrating AWS S3 for storage, Lambda Labs for on-demand GPU instances, and Nerfstudio for processing/training/export

## 🎥 Demo

**Example of 3-D reconstruction using dex.ai**

![Dex Demo](./demo.gif)

## Features
- Upload a video per project (e.g., MP4) to AWS S3
- Spin up a Lambda Labs GPU instance on demand (and stop it when done)
- Process uploaded video with Nerfstudio (`ns-process-data`)
- Train a 3D model (Gaussian Splatting via `ns-train splatfacto-big`)
- Export meshes/point clouds (`ns-export gaussian-splat`)
- Convert `.ply` to `.splat` and upload results back to S3
- Live training status via Socket.IO
- Browse/delete projects, start/stop GPU instance from the UI

## Repository Structure
```
backend/
  app.js               # Express app entry
  routes/
    lambda.js          # Lambda Labs + Nerfstudio orchestration
    s3.js              # S3 upload/list/delete APIs
  scripts/
    ply_to_splat.py    # Convert PLY to SPLAT
  views/               # Default Express views
  bin/www              # Server bootstrap

frontend/
  src/                 # React app (Auth0, project views, viewer)
  public/

main.py                # (Reserved/unused helper entry)
README.md              # This file
```

## High-Level Architecture
- Frontend (React) communicates with Backend (Express) on `http://localhost:8000`
- Backend uses AWS SDK to store project files in `s3://<bucket>/<userId>/<projectName>/`
- Backend controls Lambda Labs GPU instances via REST API, and runs remote commands over SSH
- On the GPU instance, a Dockerized Nerfstudio environment processes and trains models
- Results (mesh, `.splat`) are uploaded back to S3 for viewing/downloading

## Prerequisites
- Node.js 18+
- Python 3.9+ (for local tooling; remote GPU will install what it needs)
- AWS Account + S3 bucket
- Lambda Labs account and API key
- SSH key pair registered in Lambda Labs
- Docker available on the GPU instance (script handles pulling Nerfstudio image)

## Environment Variables
Create two `.env` files: one for the backend root (`backend/.env`) and one for the frontend as needed.

Backend `.env`:
```
PORT=8000
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1
S3_BUCKET_NAME=your-bucket

# Lambda Labs
LAMBDA_LABS_API_KEY=...
LAMBDA_LABS_SSH_KEY=your-ssh-key-name-in-lambda-labs
SSH_KEY_PATH=/absolute/path/to/your/private/key

# Comma-separated or JSON array of preferred instance types
# Example JSON array (preferred by code):
LAMBDA_LABS_INSTANCE_TYPE=["gpu_1x_a10", "gpu_1x_a100", "gpu_1x_h100"]
```

Frontend `.env` (create `frontend/.env`):
```
REACT_APP_AUTH0_DOMAIN=...
REACT_APP_AUTH0_CLIENT_ID=...
REACT_APP_AUTH0_AUDIENCE=
REACT_APP_BACKEND_URL=http://localhost:8000
```

Note: The backend currently allows CORS from `http://localhost:3000`.

## Quick Start (Run Both Backend & Frontend)

You can run the entire application on your PC with a single command from the project root:

```bash
npm start
```
*(Or double-click `run.bat` on Windows)*

This will concurrently launch:
- **Backend API**: `http://localhost:8000`
- **Frontend App**: `http://localhost:3000`

> **Note on Authentication & Local Mode**:
> Auto-redirect to Auth0 has been disabled. The app now starts directly in **Guest / Local Mode**, allowing you to view and interact with the UI without needing Auth0 credentials. If you want to connect real Auth0 authentication, you can configure your credentials in `frontend/.env` and click **Log In** from the navigation bar.

### Or Run Individually
#### Backend
```bash
cd backend
npm install
npm start
```
Starts Express on `http://localhost:8000`

#### Frontend
```bash
cd frontend
npm install
npm start
```
Starts React dev server on `http://localhost:3000`

## Core Backend Endpoints
- `POST /s3/upload` — multipart upload to `s3://<bucket>/<userId>/<projectName>/<filename>`
- `GET /s3/projects/:userId` — list project names for user
- `DELETE /s3/projects/:userId/:projectName` — delete project and all files
- `GET /s3/projects/:userId/:projectName/files` — list files with pre-signed URLs

- `POST /lambda/start_instance` — start or reuse a GPU in allowed US regions
- `POST /lambda/stop_instance` — terminate running GPU instance
- `GET /lambda/check_instance` — status of current GPU instance
- `POST /lambda/train` — run end-to-end processing/training/export pipeline

### Training Pipeline (inside `POST /lambda/train`)
1. Locate an active GPU instance (or return error)
2. `aws s3 cp --recursive s3://bucket/userId/projectName /home/ubuntu/userId/projectName`
3. `unzip -o /home/ubuntu/userId/projectName/projectName.zip -d /home/ubuntu/userId/projectName`
4. Start Docker container with `ghcr.io/nerfstudio-project/nerfstudio:latest`
5. `ns-process-data video --data ./*.mp4 --output-dir <projectName>-output --num-downscales=0 --gpu`
6. `ns-train splatfacto-big --data <projectName>-output ... --viewer.quit-on-train-completion True`
7. `ns-export gaussian-splat --load-config outputs/*/*/*/config.yml --output-dir <projectName>-mesh`
8. Upload `<projectName>-mesh` back to S3
9. Convert `splat.ply` to `point_cloud.splat` (Python) and upload to S3

Socket.IO broadcasts step-wise status updates to room `<userId>_<projectName>`.

## Frontend Overview
- Auth via Auth0 (`@auth0/auth0-react`)
- Pages
  - `Projects` — list, search, create, delete projects; control GPU instance; kick off training
  - `Rendering` — simple OBJ viewer (Three.js); can be adapted to view splats/meshes
- Components: `Navbar`, `ProjectCard`, `CreateProjectPopup`, `HowItWorks`, etc.

## Typical Workflow
1. Start GPU instance from the Projects page
2. Create a new project; upload a single `.zip` containing your video file
   - The backend expects `<projectName>.zip` with a single `.mp4` inside
   - The training step processes `./*.mp4` in the project folder
3. Click Train; monitor status messages
4. When complete, download/view assets from S3 (mesh folder and `point_cloud.splat`)
5. Stop the GPU instance to save cost

## Notes on File Naming
- If your zip contains an MP4 with a different name, ensure it extracts into the project folder. The pipeline searches for `*.mp4` when processing; you don’t strictly need to rename as long as only one MP4 exists. If multiple MP4s exist, the first match will be used.

## Security & Costs
- Treat `LAMBDA_LABS_API_KEY` and AWS credentials as secrets
- GPU instances incur cost while active; stop them when finished

## Troubleshooting
- Instance won’t start: capacity for preferred types may be unavailable in allowed regions
- Training fails early: ensure your zip contains a playable `.mp4` and that the instance can access S3
- Long runs: the server emits heartbeats over Socket.IO; keep the browser open to see updates
- CORS: backend allows origin `http://localhost:3000`; adjust in `backend/app.js` for other hosts

---

## 🛰️ SIH26158: Local-First Metric 3D Reconstruction & COLMAP Integration

This project now includes a **100% Local-First Reconstruction Pipeline** optimized for NVIDIA RTX 3050 (4GB VRAM) and Ryzen CPUs:

### Features:
- **COLMAP SfM Integration**: Cloned from [https://github.com/colmap/colmap.git](https://github.com/colmap/colmap.git) into `external/colmap` and powered by `pycolmap` for industrial-grade SIFT feature extraction and bundle adjustment.
- **Dense Depth & Confidence Mapping**: Parallax motion estimation, bilateral edge-preserving smoothing, and Turbo colormap export.
- **Pinhole Point Cloud Fusion**: Multi-view back-projection ($P_{world} = R_i^T(P_{cam} - t_i)$) with real RGB colors, voxel downsampling, and statistical outlier filtering (300k+ points).
- **2.5D Delaunay Surface Reconstruction**: Realistic terrain/structure surface mesh exported to Wavefront OBJ with vertex colors.
- **Interactive Web Inspector**:
  - Full 3D viewer with solid mesh, wireframe, and dense point cloud modes.
  - Interactive **Dense Depth & Confidence Analysis Drawer** right inside the browser.

### Running with COLMAP & Depth Anything V2:
```bash
# Run with automatic engine selection (uses COLMAP if available, with OpenCV fallback):
python reconstruct.py "workspace/hjgjghjghj/hjgjghjghj.mp4" --project-id "hjgjghjghj" --engine auto

# Explicitly force COLMAP engine:
python reconstruct.py "workspace/hjgjghjghj/hjgjghjghj.mp4" --project-id "hjgjghjghj" --engine colmap

# Run with Depth Anything V2 (Neural Foundation Model Depth Estimation):
python reconstruct.py "workspace/hjgjghjghj/hjgjghjghj.mp4" --project-id "hjgjghjghj" --depth-method depth_anything
```

### Depth Anything V2 Neural Depth Integration:
- Cloned from [https://github.com/DepthAnything/Depth-Anything-V2.git](https://github.com/DepthAnything/Depth-Anything-V2.git) into `external/Depth-Anything-V2`.
- Pre-trained ViT-S weights stored in `external/Depth-Anything-V2/checkpoints/depth_anything_v2_vits.pth`.
- Generates high-fidelity per-pixel relative depth maps with crisp structural edges, automatically aligned with metric camera trajectories.
- Seamless fallback to optical-flow parallax estimation if running on CPU or unsupported hardware.


