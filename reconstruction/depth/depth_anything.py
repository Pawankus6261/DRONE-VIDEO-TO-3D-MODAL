"""
Depth Anything V2 Integration.
State-of-the-art monocular depth estimation using the official Depth-Anything-V2 repository.
Provides dense, crisp relative and metric-scaled depth maps.
"""

import sys
from pathlib import Path
from typing import Optional, Tuple
import cv2
import numpy as np
import torch

from .estimator import DepthMapResult

# Register external/Depth-Anything-V2 path
DEPTH_ANYTHING_REPO = Path(__file__).resolve().parent.parent.parent / "external" / "Depth-Anything-V2"
CHECKPOINT_PATH = DEPTH_ANYTHING_REPO / "checkpoints" / "depth_anything_v2_vits.pth"

if str(DEPTH_ANYTHING_REPO) not in sys.path:
    sys.path.insert(0, str(DEPTH_ANYTHING_REPO))

try:
    from depth_anything_v2.dpt import DepthAnythingV2
    HAS_DEPTH_ANYTHING = True
except Exception:
    HAS_DEPTH_ANYTHING = False


def is_depth_anything_available() -> bool:
    """Checks if Depth-Anything-V2 source and checkpoint are available."""
    return HAS_DEPTH_ANYTHING and CHECKPOINT_PATH.exists()


class DepthAnythingEstimator:
    """
    High-fidelity neural dense depth estimator using Depth-Anything-V2 (ViT-Small).
    Optimized for NVIDIA RTX 3050 (4GB VRAM) and CPU inference.
    """
    _model_instance = None
    _device = None

    def __init__(
        self,
        checkpoint_path: Optional[Path] = None,
        encoder: str = "vits",
        input_size: int = 518,
        device: Optional[str] = None
    ):
        self.encoder = encoder
        self.input_size = input_size
        self.ckpt_path = Path(checkpoint_path) if checkpoint_path else CHECKPOINT_PATH

        if device is not None:
            self.device = device
        else:
            self.device = "cuda" if torch.cuda.is_available() else "cpu"

        self._ensure_model_loaded()

    def _ensure_model_loaded(self):
        """Loads and caches the model weights."""
        if DepthAnythingEstimator._model_instance is None:
            if not self.ckpt_path.exists():
                raise FileNotFoundError(f"Depth-Anything-V2 checkpoint not found at: {self.ckpt_path}")

            model_configs = {
                'vits': {'encoder': 'vits', 'features': 64, 'out_channels': [48, 96, 192, 384]},
                'vitb': {'encoder': 'vitb', 'features': 128, 'out_channels': [96, 192, 384, 768]},
                'vitl': {'encoder': 'vitl', 'features': 256, 'out_channels': [256, 512, 1024, 1024]},
            }
            config = model_configs.get(self.encoder, model_configs['vits'])
            model = DepthAnythingV2(**config)
            state_dict = torch.load(str(self.ckpt_path), map_location="cpu")
            model.load_state_dict(state_dict)
            model = model.to(self.device).eval()

            DepthAnythingEstimator._model_instance = model
            DepthAnythingEstimator._device = self.device

        self.model = DepthAnythingEstimator._model_instance

    def estimate(
        self,
        image_bgr: np.ndarray,
        metric_scale_factor: float = 12.0,
        min_distance_m: float = 2.0
    ) -> DepthMapResult:
        """
        Runs neural depth inference on a single BGR frame.
        Inverts relative depth (where higher values = closer) into distance (meters).
        """
        h_orig, w_orig = image_bgr.shape[:2]

        # Neural inference
        raw_depth = self.model.infer_image(image_bgr, input_size=self.input_size)

        # Depth Anything produces relative disparity/depth (higher value = closer to camera)
        # Normalize to [0.0, 1.0]
        d_min = float(np.percentile(raw_depth, 1))
        d_max = float(np.percentile(raw_depth, 99))
        norm_depth = np.clip((raw_depth - d_min) / max(1e-5, (d_max - d_min)), 0.0, 1.0)

        # Invert to metric distance (Z): closer = smaller distance in meters
        metric_depth = min_distance_m + (1.0 - norm_depth) * metric_scale_factor
        metric_depth = metric_depth.astype(np.float32)

        # Bilateral filter for boundary crispness
        metric_depth_filtered = cv2.bilateralFilter(metric_depth, d=5, sigmaColor=1.2, sigmaSpace=5)

        # Compute texture confidence
        gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
        gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
        gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
        grad = np.sqrt(gx**2 + gy**2)
        confidence = np.clip(grad / 35.0 + 0.35, 0.2, 1.0).astype(np.float32)

        # Turbo colormap visualization
        disp_viz = cv2.normalize(norm_depth, None, alpha=0, beta=255, norm_type=cv2.NORM_MINMAX, dtype=cv2.CV_8U)
        depth_colored = cv2.applyColorMap(disp_viz, cv2.COLORMAP_TURBO)

        return DepthMapResult(
            depth_map=metric_depth_filtered,
            confidence_map=confidence,
            depth_colored=depth_colored,
            mean_depth=float(np.mean(metric_depth_filtered)),
            min_depth=float(np.min(metric_depth_filtered)),
            max_depth=float(np.max(metric_depth_filtered))
        )
