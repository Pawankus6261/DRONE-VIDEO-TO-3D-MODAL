import React, { useState, useEffect, useRef } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import axios from "axios";
import { io } from "socket.io-client";
import { 
  Trash2, 
  Info, 
  X, 
  PlayCircle, 
  Calendar, 
  Check, 
  AlertCircle, 
  Loader2, 
  Eye, 
  Film,
  Layers,
  ChevronLeft,
  ChevronRight
} from "lucide-react";

const ProjectCard = ({ project, onDelete, instanceRunning }) => {
  const { user } = useAuth0();

  const getUserId = () => {
    if (user?.sub) {
      return user.sub.includes('|') ? user.sub.split('|')[1] : user.sub;
    }
    return 'local_user';
  };
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [splatFileUrl, setObjFileUrl] = useState(null);
  const [splatFileStatus, setObjFileStatus] = useState("loading");
  const [isTraining, setIsTraining] = useState(false);
  const [trainingProgress, setTrainingProgress] = useState({
    step: '',
    status: '',
    message: '',
    startTime: null
  });
  const [stageStatuses, setStageStatuses] = useState({});
  const [activityLog, setActivityLog] = useState([]);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [isDepthModalOpen, setIsDepthModalOpen] = useState(false);
  const [depthData, setDepthData] = useState(null);
  const [loadingDepth, setLoadingDepth] = useState(false);
  const [selectedDepthFrame, setSelectedDepthFrame] = useState(0);
  const [depthViewTab, setDepthViewTab] = useState("depth"); // 'depth' | 'rgb' | 'confidence'
  const socketRef = useRef(null);
  const modalRef = useRef(null);
  const depthModalRef = useRef(null);
  const timerIntervalRef = useRef(null);
  const heartbeatIntervalRef = useRef(null);
  const reconnectAttemptRef = useRef(0);
  const logEndRef = useRef(null);

  const handleOpenDepthModal = () => {
    setIsDepthModalOpen(true);
    setLoadingDepth(true);
    axios.get(`http://localhost:8000/s3/projects/${getUserId()}/${project}/depth-analysis`)
      .then(res => {
        setDepthData(res.data);
        setLoadingDepth(false);
      })
      .catch(err => {
        console.warn("Could not fetch depth analysis:", err.message);
        setDepthData(null);
        setLoadingDepth(false);
      });
  };

  // Create a formatted date for display
  const formattedDate = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });

  // Handle click outside to close modal
  useEffect(() => {
    function handleClickOutside(event) {
      if (modalRef.current && !modalRef.current.contains(event.target)) {
        setIsModalOpen(false);
      }
    }
    
    if (isModalOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isModalOpen]);

  // Initialize socket connection when component mounts
  useEffect(() => {
    // Only create the socket if the user is logged in
    if (user) {
      // Clear any existing intervals
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
      
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }
      
      // Socket.IO configuration with reconnection options
      const socket = io("http://localhost:8000", {
        withCredentials: true,
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        timeout: 20000,
        transports: ['websocket', 'polling']
      });
      
      socketRef.current = socket;

      // Set up event listeners for the socket
      socket.on("connect", () => {
        console.log("Socket connected:", socket.id);
        reconnectAttemptRef.current = 0;
        
        // If modal is open, re-subscribe to the room
        if (isModalOpen) {
          const userId = getUserId();
          socket.emit('subscribe', {
            userId: userId,
            projectId: project
          });
        }
        
        // Setup heartbeat interval to keep connection alive
        if (heartbeatIntervalRef.current) {
          clearInterval(heartbeatIntervalRef.current);
        }
        
        heartbeatIntervalRef.current = setInterval(() => {
          if (socket.connected) {
            socket.emit('ping', (response) => {
              console.log("Heartbeat response:", response);
            });
          }
        }, 30000); // Send heartbeat every 30 seconds
      });
      
      socket.on("connect_error", (error) => {
        console.error("Socket connection error:", error);
      });
      
      socket.on("reconnect_attempt", (attemptNumber) => {
        reconnectAttemptRef.current = attemptNumber;
        console.log(`Socket reconnection attempt ${attemptNumber}`);
      });
      
      socket.on("reconnect", (attemptNumber) => {
        console.log(`Socket reconnected after ${attemptNumber} attempts`);
        
        // If modal is open, re-subscribe to the room
        if (isModalOpen) {
          const userId = getUserId();
          socket.emit('subscribe', {
            userId: userId,
            projectId: project
          });
        }
      });
      
      socket.on("reconnect_error", (error) => {
        console.error("Socket reconnection error:", error);
      });
      
      socket.on("reconnect_failed", () => {
        console.error("Socket reconnection failed");
        
        if (isTraining) {
          setTrainingProgress(prev => ({
            ...prev,
            status: 'warning',
            message: 'Connection lost. Training may still be in progress in the background.'
          }));
        }
      });
      
      socket.on("disconnect", (reason) => {
        console.log(`Socket disconnected. Reason: ${reason}`);
        
        // If the server initiated the disconnect, attempt to reconnect
        if (reason === 'io server disconnect') {
          socket.connect();
        }
      });

      socket.on("subscribeAck", (data) => {
        console.log("Subscription acknowledged:", data);
      });

      socket.on("trainingStatus", (data) => {
        console.log("Training status update:", data);
        
        // Update the training progress state
        setTrainingProgress(prev => ({
          ...prev,
          step: data.step,
          status: data.status,
          message: data.message
        }));

        // Track per-stage status for the pipeline console
        if (data.step && data.step.startsWith('stage')) {
          setStageStatuses(prev => ({ ...prev, [data.step]: data.status }));
        }

        // Append to the scrolling activity log
        const ts = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
        setActivityLog(prev => [
          ...prev.slice(-80), // keep last 80 entries
          { ts, message: data.message, status: data.status, step: data.step }
        ]);


        // If final step is completed, update the UI accordingly
        if (data.step === 'final' && data.status === 'completed') {
          setIsTraining(false);
          if (timerIntervalRef.current) {
            clearInterval(timerIntervalRef.current);
            timerIntervalRef.current = null;
          }
          if (data.splatPath) {
            const bucketName = process.env.REACT_APP_S3_BUCKET_NAME || 'dex-model-storage';
            setObjFileUrl(`https://${bucketName}.s3.amazonaws.com/${data.splatPath}`);
            setObjFileStatus("available");
          }
        }
        if (data.status === 'error') {
          setIsTraining(false);
          if (timerIntervalRef.current) {
            clearInterval(timerIntervalRef.current);
            timerIntervalRef.current = null;
          }
        }
      });

      // Clean up the socket when component unmounts
      return () => {
        if (heartbeatIntervalRef.current) {
          clearInterval(heartbeatIntervalRef.current);
          heartbeatIntervalRef.current = null;
        }
        
        if (timerIntervalRef.current) {
          clearInterval(timerIntervalRef.current);
          timerIntervalRef.current = null;
        }
        
        if (socketRef.current) {
          socketRef.current.disconnect();
          socketRef.current = null;
        }
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, isModalOpen, project, isTraining]);

  const handleDelete = () => {
    if (window.confirm(`Are you sure you want to delete the project "${project}"?`)) {
      onDelete(project);
    }
  };

  const fetchProjectFiles = async (targetUserId, projectName) => {
    try {
      const activeUserId = targetUserId || getUserId();
      const response = await fetch(`http://localhost:8000/s3/projects/${activeUserId}/${projectName}/files`);
      if (!response.ok) {
        throw new Error(`Failed to fetch files: ${response.statusText}`);
      }
      const data = await response.json();
      return data.files || [];
    } catch (error) {
      console.error("Error fetching project files:", error);
      return [];
    }
  };

  useEffect(() => {
    if (isModalOpen) {
      setObjFileStatus("loading");
      fetchProjectFiles(getUserId(), project)
        .then((fileList) => {
          const modelFile =
            fileList.find((file) => file.fileName.endsWith(".glb")) ||
            fileList.find((file) => file.fileName.endsWith(".obj")) ||
            fileList.find((file) => file.fileName.endsWith(".splat"));
          if (modelFile) {
            setObjFileUrl(modelFile.url);
            setObjFileStatus("available");
          } else {
            setObjFileStatus("unavailable");
          }
        })
        .catch((error) => {
          console.error("Error fetching files:", error);
          setObjFileStatus("unavailable");
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isModalOpen, user, project]);

  const handleViewRendering = () => {
    if (splatFileUrl) {
      window.open(`/rendering?objFileUrl=${encodeURIComponent(splatFileUrl)}&projectName=${encodeURIComponent(project)}`, "_blank");
    }
  };

  // Auto-scroll the activity log whenever it grows
  useEffect(() => {
    if (logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [activityLog]);

  const handleTrain = async () => {
    setIsTraining(true);
    setStageStatuses({});
    setActivityLog([]);
    const startTime = new Date();
    setTrainingProgress({
      step: 'starting',
      status: 'running',
      message: 'Initializing SIH26158 reconstruction pipeline...',
      startTime: startTime
    });
    
    // Start the elapsed time counter
    setElapsedSeconds(0);
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
    }
    
    timerIntervalRef.current = setInterval(() => {
      setElapsedSeconds(prev => prev + 1);
    }, 1000);
    
    try {
      // Ensure we're connected to socket.io before starting
      if (socketRef.current && !socketRef.current.connected) {
        console.log("Socket disconnected, attempting to reconnect...");
        socketRef.current.connect();
      }

      const userId = getUserId();
      
      // Re-subscribe to the room to ensure we receive updates
      if (socketRef.current) {
        socketRef.current.emit('subscribe', {
          userId: userId,
          projectId: project
        });
      }
      
      const response = await axios.post('http://localhost:8000/lambda/train', {
        userId,
        projectName: project
      });

      // The response happens when everything is complete,
      // but we'll let the socket events handle progress updates
      if (response.data.status === "success") {
        // If the API returns a direct splatPath, use it instead of searching files
        if (response.data.splatPath) {
          const bucketName = process.env.REACT_APP_S3_BUCKET_NAME || 'dex-model-storage';
          const splatFileUrl = `https://${bucketName}.s3.amazonaws.com/${response.data.splatPath}`;
          setObjFileUrl(splatFileUrl);
          setObjFileStatus("available");
        } else {
          // Fallback to searching for model files (GLB preferred)
          setObjFileStatus("loading");
          const files = await fetchProjectFiles(userId, project);
          const modelFile =
            files.find((file) => file.fileName.endsWith(".glb")) ||
            files.find((file) => file.fileName.endsWith(".obj")) ||
            files.find((file) => file.fileName.endsWith(".splat"));
          if (modelFile) {
            setObjFileUrl(modelFile.url);
            setObjFileStatus("available");
          }
        }
      }
    } catch (error) {
      console.error("Error training model:", error);
      setTrainingProgress(prev => ({
        ...prev,
        status: 'error',
        message: `Training failed: ${error.message || 'Unknown error'}`
      }));
      setIsTraining(false);
      
      // Stop the timer
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
      
      alert("Failed to train model. Please try again later.");
    }
  };
  
  // ── Premium Pipeline Console ──────────────────────────────────────────────
  const renderProgressStatus = () => {
    if (!isTraining && activityLog.length === 0) return null;

    const PIPELINE_STAGES = [
      { key: 'stage1', label: 'Keyframe Extraction', icon: '🎞️', desc: 'Adaptive quality filtering' },
      { key: 'stage2', label: 'Structure-from-Motion', icon: '📐', desc: 'COLMAP / OpenCV RANSAC' },
      { key: 'stage3', label: 'Dense Depth Maps', icon: '🌊', desc: 'Depth Anything estimation' },
      { key: 'stage4', label: 'Point Cloud Fusion', icon: '☁️', desc: 'Multi-view back-projection' },
      { key: 'stage5', label: 'Surface Mesh & GLB', icon: '🧊', desc: 'Delaunay + GLB export' },
      { key: 'stage6', label: 'Asset Sync', icon: '🔄', desc: 'Copy to viewer' },
    ];

    const stageOrder = PIPELINE_STAGES.map(s => s.key);
    // Determine overall progress from completed stages
    const completedCount = stageOrder.filter(k => stageStatuses[k] === 'completed').length;
    const activeIdx = stageOrder.findIndex(k => stageStatuses[k] === 'running');
    const progressPct = isTraining
      ? Math.max(4, Math.min(99, (completedCount / 6) * 100 + (activeIdx >= 0 ? 8 : 0)))
      : trainingProgress.status === 'error' ? 100 : 100;
    const isError = trainingProgress.status === 'error';
    const isDone = !isTraining && trainingProgress.step === 'final';

    const formatTime = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

    const stageColor = (key) => {
      const st = stageStatuses[key];
      if (st === 'completed') return { dot: 'bg-emerald-400', text: 'text-emerald-400', ring: 'ring-emerald-500/30' };
      if (st === 'running')   return { dot: 'bg-cyan-400 animate-pulse', text: 'text-cyan-300', ring: 'ring-cyan-500/40' };
      if (st === 'error')     return { dot: 'bg-red-400', text: 'text-red-400', ring: 'ring-red-500/30' };
      return { dot: 'bg-gray-600', text: 'text-gray-500', ring: 'ring-gray-700/20' };
    };

    const logColor = (status) => {
      if (status === 'error')     return 'text-red-400';
      if (status === 'completed') return 'text-emerald-400';
      if (status === 'running')   return 'text-cyan-300';
      return 'text-gray-400';
    };

    return (
      <div className="mt-4 rounded-xl overflow-hidden border border-gray-700 shadow-2xl" style={{background: 'linear-gradient(135deg, #0d1117 0%, #0f172a 100%)'}}>
        {/* Header Bar */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-800" style={{background: '#161b22'}}>
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-red-500"></span>
            <span className="w-2.5 h-2.5 rounded-full bg-yellow-500"></span>
            <span className="w-2.5 h-2.5 rounded-full bg-green-500"></span>
            <span className="ml-2 text-[11px] font-mono text-gray-400 tracking-widest">SIH26158 — Reconstruction Pipeline</span>
          </div>
          <div className="flex items-center gap-2">
            {isTraining && (
              <span className="flex items-center gap-1 text-[10px] text-cyan-400 font-mono">
                <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-ping inline-block"></span>
                LIVE
              </span>
            )}
            <span className="text-xl font-mono font-bold tracking-wider" style={{color: isError ? '#f87171' : isDone ? '#34d399' : '#67e8f9'}}>
              {formatTime(elapsedSeconds)}
            </span>
          </div>
        </div>

        {/* Pipeline Stage Tracker */}
        <div className="px-4 pt-3 pb-2">
          <div className="grid grid-cols-3 gap-1.5 mb-3">
            {PIPELINE_STAGES.map((stage, i) => {
              const col = stageColor(stage.key);
              const st = stageStatuses[stage.key];
              return (
                <div
                  key={stage.key}
                  className={`flex items-start gap-2 p-2 rounded-lg ring-1 transition-all duration-300 ${col.ring}`}
                  style={{background: st === 'running' ? 'rgba(6,182,212,0.06)' : st === 'completed' ? 'rgba(52,211,153,0.04)' : 'rgba(255,255,255,0.02)'}}
                >
                  <div className="flex flex-col items-center pt-0.5">
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${col.dot}`}></span>
                    {i < 5 && <span className="w-px flex-1 mt-1 bg-gray-700"></span>}
                  </div>
                  <div className="min-w-0">
                    <p className={`text-[10px] font-bold leading-tight ${col.text}`}>{stage.icon} {stage.label}</p>
                    <p className="text-[9px] text-gray-600 leading-tight truncate">{stage.desc}</p>
                    {st === 'completed' && <span className="text-[9px] text-emerald-500 font-mono">✓ done</span>}
                    {st === 'running'   && <span className="text-[9px] text-cyan-400 font-mono animate-pulse">⚡ running</span>}
                    {st === 'error'     && <span className="text-[9px] text-red-400 font-mono">✕ failed</span>}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Progress Bar */}
          <div className="w-full rounded-full h-1.5 overflow-hidden mb-2" style={{background: '#1f2937'}}>
            <div
              className={`h-1.5 rounded-full transition-all duration-700 ease-out`}
              style={{
                width: `${progressPct}%`,
                background: isError ? '#f87171' : isDone ? 'linear-gradient(90deg,#34d399,#059669)' : 'linear-gradient(90deg,#06b6d4,#3b82f6)'
              }}
            />
          </div>

          {/* Current Action Message */}
          <p className="text-[10px] font-mono truncate mb-2" style={{color: isError ? '#f87171' : '#94a3b8'}}>
            {'>'} {trainingProgress.message || 'Waiting for pipeline...'}
          </p>
        </div>

        {/* Scrolling Activity Log */}
        <div
          className="mx-3 mb-3 rounded-lg overflow-y-auto font-mono text-[10px] leading-relaxed p-2"
          style={{background: '#020408', maxHeight: '130px', scrollbarWidth: 'thin', scrollbarColor: '#1f2937 transparent'}}
        >
          {activityLog.length === 0 ? (
            <span className="text-gray-700">Waiting for pipeline output...</span>
          ) : (
            activityLog.map((entry, idx) => (
              <div key={idx} className="flex gap-2">
                <span className="text-gray-700 flex-shrink-0">[{entry.ts}]</span>
                <span className={logColor(entry.status)}>{entry.message}</span>
              </div>
            ))
          )}
          <div ref={logEndRef} />
        </div>
      </div>
    );
  };
  
  // Show state badge based on file status
  const renderStatusBadge = () => {
    if (isTraining) {
      return (
        <div className="absolute top-4 right-4 bg-blue-100 text-blue-800 text-xs px-2 py-1 rounded-full flex items-center">
          <Loader2 className="w-3 h-3 mr-1 animate-spin" />
          Training
        </div>
      );
    } else if (splatFileStatus === "available") {
      return (
        <div className="absolute top-4 right-4 bg-green-100 text-green-800 text-xs px-2 py-1 rounded-full flex items-center">
          <Check className="w-3 h-3 mr-1" />
          Ready
        </div>
      );
    } else if (splatFileStatus === "unavailable") {
      return (
        <div className="absolute top-4 right-4 bg-amber-100 text-amber-800 text-xs px-2 py-1 rounded-full flex items-center">
          <AlertCircle className="w-3 h-3 mr-1" />
          Untrained
        </div>
      );
    }
    return null;
  };

  return (
    <>
      <div className="bg-white shadow-lg rounded-xl p-6 hover:shadow-xl transition-all duration-300 relative border border-gray-100">
        {renderStatusBadge()}
        
        <div className="flex items-center mb-4">
          <Film className="text-teal-500 w-5 h-5 mr-2" />
          <h2 className="text-xl font-bold text-gray-800">{project}</h2>
        </div>
        
        <div className="flex items-center text-sm text-gray-500 mb-5">
          <Calendar className="w-4 h-4 mr-1" />
          <span>{formattedDate}</span>
        </div>
        
        <div className="flex space-x-2 mt-4">
          <button
            onClick={() => setIsModalOpen(true)}
            className="flex-1 px-3 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors duration-200 shadow-sm flex items-center justify-center text-xs font-semibold"
          >
            <Info className="w-3.5 h-3.5 mr-1.5" />
            Details
          </button>
          <button
            onClick={handleOpenDepthModal}
            className="px-3 py-2 bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100 rounded-lg transition-colors duration-200 text-xs font-semibold flex items-center justify-center gap-1"
            title="Inspect Depth Analysis & Confidence"
          >
            <Layers className="w-3.5 h-3.5" />
            Depth
          </button>
          <button
            onClick={handleDelete}
            className="p-2 bg-gray-100 text-gray-600 rounded-lg hover:bg-red-50 hover:text-red-600 transition-colors duration-200"
            title="Delete Project"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Enhanced Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
          <div 
            ref={modalRef}
          className="bg-white rounded-xl p-6 max-w-xl w-full mx-auto shadow-2xl transform transition-all duration-300 ease-out"
          >
            <div className="flex justify-between items-center mb-5">
              <h2 className="text-2xl font-bold text-gray-800 flex items-center">
                <Film className="text-teal-500 w-6 h-6 mr-2" />
                {project}
              </h2>
              <button
                onClick={() => setIsModalOpen(false)}
                className="p-1.5 hover:bg-gray-100 rounded-full transition-colors duration-200"
              >
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>
            
            <div className="bg-gray-50 p-4 rounded-lg border border-gray-200 mb-5">
              <div className="flex items-center">
                <Calendar className="w-4 h-4 text-gray-500 mr-2" />
                <span className="text-gray-700"><strong>Created:</strong> {formattedDate}</span>
              </div>
              
              <div className="mt-2 flex items-center">
                <Info className="w-4 h-4 text-gray-500 mr-2" />
                <span className="text-gray-700">
                  <strong>Status:</strong> {
                    isTraining ? 'Training in progress' :
                    splatFileStatus === "available" ? 'Model ready to view' :
                    splatFileStatus === "unavailable" ? 'Needs training' : 'Checking status...'
                  }
                </span>
              </div>
            </div>

            {/* Pipeline console — visible during training and after completion */}
            {(isTraining || activityLog.length > 0) && renderProgressStatus()}

            {/* Show loading indicator when checking status */}
            {splatFileStatus === "loading" && !isTraining && (
              <div className="flex justify-center items-center py-8">
                <Loader2 className="w-8 h-8 text-teal-500 animate-spin" />
                <span className="ml-3 text-gray-600">Loading project status...</span>
              </div>
            )}
            
            {/* Show View button if splat file is available */}
            {splatFileStatus === "available" && !isTraining && (
              <div className="mt-6 flex flex-col gap-2">
                <button
                  onClick={handleViewRendering}
                  className="w-full py-3 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors duration-200 shadow-md flex items-center justify-center font-semibold"
                >
                  <Eye className="w-5 h-5 mr-2" />
                  View 3D Local Reconstruction
                </button>
                <button
                  onClick={handleOpenDepthModal}
                  className="w-full py-2.5 bg-amber-50 text-amber-800 border border-amber-300 rounded-lg hover:bg-amber-100 transition-colors duration-200 flex items-center justify-center text-sm font-semibold gap-2"
                >
                  <Layers className="w-4 h-4" />
                  Analyze Dense Depth & Confidence
                </button>
                <p className="text-xs text-center text-gray-500">
                  Runs local Three.js engine with true RGB vertex colors
                </p>
              </div>
            )}
            
            {/* Show Train button if needed */}
            {splatFileStatus === "unavailable" && !isTraining && (
              <div className="mt-6">
                {!instanceRunning ? (
                  <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-sm flex items-center">
                    <AlertCircle className="w-5 h-5 mr-2 flex-shrink-0" />
                    <p>You need to start the instance before training your model.</p>
                  </div>
                ) : (
                  <button 
                    onClick={handleTrain}
                    disabled={isTraining}
                    className={`w-full py-3 rounded-lg transition-colors duration-200 shadow-md flex items-center justify-center ${
                      isTraining 
                        ? 'bg-gray-300 text-gray-600 cursor-not-allowed' 
                        : 'bg-teal-600 text-white hover:bg-teal-700'
                    }`}
                  >
                    <PlayCircle className="w-5 h-5 mr-2" />
                    {isTraining ? 'Training in progress...' : 'Train 3D Model'}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Depth Analysis Modal */}
      {isDepthModalOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
          <div 
            ref={depthModalRef}
            className="bg-gray-900 border border-gray-800 rounded-2xl p-6 max-w-2xl w-full mx-auto shadow-2xl text-white transform transition-all max-h-[90vh] overflow-y-auto"
          >
            <div className="flex justify-between items-center mb-4 pb-3 border-b border-gray-800">
              <div className="flex items-center gap-2">
                <Layers className="w-6 h-6 text-amber-400" />
                <div>
                  <h2 className="text-lg font-bold text-white">Dense Depth & Parallax Analysis</h2>
                  <p className="text-xs text-gray-400">Project: <span className="text-teal-300 font-mono">{project}</span></p>
                </div>
              </div>
              <button
                onClick={() => setIsDepthModalOpen(false)}
                className="p-1.5 hover:bg-gray-800 rounded-full text-gray-400 hover:text-white transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {loadingDepth ? (
              <div className="py-16 flex flex-col items-center justify-center">
                <Loader2 className="w-10 h-10 text-amber-400 animate-spin mb-3" />
                <p className="text-sm text-gray-300">Loading depth analytics & maps...</p>
              </div>
            ) : depthData ? (
              <div className="flex flex-col gap-4">
                {/* Metric Badges */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 bg-gray-950 p-3 rounded-xl border border-gray-800">
                  <div className="bg-gray-900/60 p-2.5 rounded-lg">
                    <span className="text-[10px] text-gray-400 uppercase tracking-wider block">Mean Depth</span>
                    <span className="text-lg font-bold text-teal-300">{depthData.overall_scene_mean_depth_m} m</span>
                  </div>
                  <div className="bg-gray-900/60 p-2.5 rounded-lg">
                    <span className="text-[10px] text-gray-400 uppercase tracking-wider block">Depth Range</span>
                    <span className="text-sm font-semibold text-gray-200 mt-1 block">
                      {depthData.overall_scene_min_depth_m}m - {depthData.overall_scene_max_depth_m}m
                    </span>
                  </div>
                  <div className="bg-gray-900/60 p-2.5 rounded-lg">
                    <span className="text-[10px] text-gray-400 uppercase tracking-wider block">Confidence</span>
                    <span className="text-lg font-bold text-emerald-400">{depthData.overall_high_confidence_pct}%</span>
                  </div>
                  <div className="bg-gray-900/60 p-2.5 rounded-lg">
                    <span className="text-[10px] text-gray-400 uppercase tracking-wider block">Keyframes</span>
                    <span className="text-lg font-bold text-amber-400">{depthData.total_keyframes}</span>
                  </div>
                </div>

                {/* Per-Frame Inspector */}
                {depthData.per_frame_analysis && depthData.per_frame_analysis.length > 0 && (
                  <div className="bg-gray-950 p-4 rounded-xl border border-gray-800 flex flex-col gap-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-gray-300">
                        Frame {selectedDepthFrame + 1} of {depthData.per_frame_analysis.length}:{" "}
                        <span className="text-gray-400 font-mono text-[11px]">{depthData.per_frame_analysis[selectedDepthFrame]?.filename}</span>
                      </span>
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => setSelectedDepthFrame(Math.max(0, selectedDepthFrame - 1))}
                          disabled={selectedDepthFrame === 0}
                          className="p-1 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-30"
                        >
                          <ChevronLeft className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => setSelectedDepthFrame(Math.min(depthData.per_frame_analysis.length - 1, selectedDepthFrame + 1))}
                          disabled={selectedDepthFrame === depthData.per_frame_analysis.length - 1}
                          className="p-1 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-30"
                        >
                          <ChevronRight className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    {/* View Tabs */}
                    <div className="grid grid-cols-4 gap-1 bg-gray-900 p-1 rounded-lg text-xs font-medium text-center mb-2">
                      <button
                        onClick={() => setDepthViewTab("depth")}
                        className={`py-1.5 rounded transition-colors ${depthViewTab === "depth" ? "bg-teal-500 text-black font-semibold" : "text-gray-400 hover:text-white"}`}
                      >
                        Colorized Depth
                      </button>
                      <button
                        onClick={() => setDepthViewTab("rgb")}
                        className={`py-1.5 rounded transition-colors ${depthViewTab === "rgb" ? "bg-teal-500 text-black font-semibold" : "text-gray-400 hover:text-white"}`}
                      >
                        Drone RGB
                      </button>
                      <button
                        onClick={() => setDepthViewTab("confidence")}
                        className={`py-1.5 rounded transition-colors ${depthViewTab === "confidence" ? "bg-teal-500 text-black font-semibold" : "text-gray-400 hover:text-white"}`}
                      >
                        Confidence
                      </button>
                      <button
                        onClick={() => setDepthViewTab("yolo")}
                        className={`py-1.5 rounded transition-colors ${depthViewTab === "yolo" ? "bg-emerald-400 text-black font-semibold" : "text-emerald-400/80 hover:text-emerald-300"}`}
                      >
                        YOLO Seg
                      </button>
                    </div>

                    {/* Frame Preview Image */}
                    <div className="w-full aspect-video rounded-lg overflow-hidden border border-gray-800 bg-black relative shadow-inner">
                      <img
                        src={
                          depthViewTab === "depth"
                            ? depthData.per_frame_analysis[selectedDepthFrame]?.depth_url
                            : depthViewTab === "rgb"
                            ? depthData.per_frame_analysis[selectedDepthFrame]?.keyframe_url
                            : depthViewTab === "confidence"
                            ? depthData.per_frame_analysis[selectedDepthFrame]?.confidence_url
                            : depthData.per_frame_analysis[selectedDepthFrame]?.segmentation_url
                        }
                        alt="Depth Frame Inspection"
                        className="w-full h-full object-contain"
                      />
                      <div className="absolute bottom-2 right-2 bg-black/80 px-2 py-1 rounded text-[10px] text-gray-300 backdrop-blur">
                        {depthViewTab === "depth" && "Turbo Colormap: Red (near) to Blue (far)"}
                        {depthViewTab === "confidence" && "Texture & Parallax Consistency Map"}
                        {depthViewTab === "rgb" && "Undistorted Keyframe"}
                        {depthViewTab === "yolo" && "YOLOv8 Instance & Object Segmentation"}
                      </div>
                    </div>

                    {/* YOLO Detected Objects Badges */}
                    {depthData.per_frame_analysis[selectedDepthFrame]?.detected_objects && depthData.per_frame_analysis[selectedDepthFrame].detected_objects.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5 pt-1.5">
                        <span className="text-[10px] text-gray-400 font-medium">Detected Elements:</span>
                        {depthData.per_frame_analysis[selectedDepthFrame].detected_objects.map((clsName, cIdx) => (
                          <span 
                            key={cIdx} 
                            className="px-2 py-0.5 bg-emerald-950/80 border border-emerald-600/50 text-emerald-300 rounded text-[10px] font-mono font-medium shadow-sm"
                          >
                            {clsName}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Stats for Frame */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs pt-1">
                      <div className="bg-gray-900 p-2 rounded">
                        <span className="text-gray-400 text-[10px] block">Mean Depth</span>
                        <span className="text-teal-300 font-mono font-semibold">{depthData.per_frame_analysis[selectedDepthFrame]?.mean_depth_m} m</span>
                      </div>
                      <div className="bg-gray-900 p-2 rounded">
                        <span className="text-gray-400 text-[10px] block">Min - Max</span>
                        <span className="text-gray-200 font-mono font-semibold">{depthData.per_frame_analysis[selectedDepthFrame]?.min_depth_m} - {depthData.per_frame_analysis[selectedDepthFrame]?.max_depth_m}m</span>
                      </div>
                      <div className="bg-gray-900 p-2 rounded">
                        <span className="text-gray-400 text-[10px] block">Std Dev</span>
                        <span className="text-gray-300 font-mono font-semibold">±{depthData.per_frame_analysis[selectedDepthFrame]?.depth_std_m} m</span>
                      </div>
                      <div className="bg-gray-900 p-2 rounded">
                        <span className="text-gray-400 text-[10px] block">Coverage</span>
                        <span className="text-emerald-400 font-mono font-semibold">{depthData.per_frame_analysis[selectedDepthFrame]?.high_confidence_percent}%</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Comparative Matrix Preview */}
                {depthData.summary_image_url && (
                  <div className="bg-gray-950 p-3 rounded-xl border border-gray-800">
                    <span className="text-xs font-semibold text-gray-300 block mb-2">Multi-View Comparison Overview</span>
                    <a href={depthData.summary_image_url} target="_blank" rel="noreferrer" className="block rounded-lg overflow-hidden border border-gray-800 hover:border-teal-500 transition-colors">
                      <img src={depthData.summary_image_url} alt="Comparison Overview" className="w-full object-cover max-h-40" />
                    </a>
                  </div>
                )}

                <div className="pt-2 flex justify-end">
                  <button
                    onClick={() => {
                      setIsDepthModalOpen(false);
                      handleViewRendering();
                    }}
                    className="px-5 py-2.5 bg-teal-600 hover:bg-teal-500 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-md"
                  >
                    <Eye className="w-4 h-4" />
                    Open 3D Model in Viewer
                  </button>
                </div>
              </div>
            ) : (
              <div className="py-12 text-center text-gray-400">
                <AlertCircle className="w-10 h-10 mx-auto text-amber-500 mb-2" />
                <p className="text-sm font-semibold">No Depth Analysis Found</p>
                <p className="text-xs text-gray-500 mt-1">Please train or reconstruct the project to generate dense depth maps.</p>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
};

export default ProjectCard;
