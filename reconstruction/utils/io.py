"""
Workspace and File I/O Utilities.
Guarantees sandbox isolation, directory initialization, and safe JSON persistence.
"""

import json
import re
from pathlib import Path
from typing import Any, Dict
from reconstruction.config import DEFAULT_CONFIG, WorkspaceConfig


def sanitize_project_id(project_id: str) -> str:
    """
    Sanitize project ID to prevent path traversal or invalid filesystem characters.
    """
    cleaned = re.sub(r'[^a-zA-Z0-9_\-]', '_', project_id)
    if not cleaned:
        raise ValueError("Project ID cannot be empty or contain only invalid characters")
    return cleaned


class WorkspaceManager:
    """
    Manages the lifecycle of a local project reconstruction workspace.
    """
    def __init__(self, project_id: str, config: WorkspaceConfig = DEFAULT_CONFIG.workspace):
        self.project_id = sanitize_project_id(project_id)
        self.config = config
        self.root = (self.config.base_dir / self.project_id).resolve()
        
        # Directory map
        self.dirs: Dict[str, Path] = {}
        for sub in self.config.subdirs:
            self.dirs[sub] = self.root / sub

    def init_workspace(self) -> None:
        """Create all required workspace subdirectories if they do not exist."""
        self.root.mkdir(parents=True, exist_ok=True)
        for sub_path in self.dirs.values():
            sub_path.mkdir(parents=True, exist_ok=True)

    def get_path(self, subdir: str, filename: str = "") -> Path:
        """Get absolute path to a file or directory within the workspace."""
        if subdir not in self.dirs:
            target_dir = self.root / subdir
            target_dir.mkdir(parents=True, exist_ok=True)
        else:
            target_dir = self.dirs[subdir]
            
        if filename:
            target = (target_dir / filename).resolve()
            # Ensure path doesn't escape workspace root
            if not str(target).startswith(str(self.root)):
                raise ValueError(f"Security violation: path traversal detected for {filename}")
            return target
        return target_dir

    def write_json(self, subdir: str, filename: str, data: Any) -> Path:
        """Safely write JSON file with pretty formatting."""
        target_path = self.get_path(subdir, filename)
        with open(target_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, default=str)
        return target_path

    def read_json(self, subdir: str, filename: str) -> Dict[str, Any]:
        """Read and parse JSON file from workspace."""
        target_path = self.get_path(subdir, filename)
        if not target_path.exists():
            raise FileNotFoundError(f"File not found: {target_path}")
        with open(target_path, "r", encoding="utf-8") as f:
            return json.load(f)
