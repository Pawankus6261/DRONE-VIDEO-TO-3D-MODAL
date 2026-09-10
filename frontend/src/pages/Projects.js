import React, { useCallback, useEffect, useState } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import axios from "axios";
import Navbar from "../components/Navbar";
import ProjectCard from "../components/ProjectCard";
import { 
  Power, 
  AlertCircle, 
  CheckCircle, 
  Clock, 
  Cloud, 
  CloudOff, 
  Server, 
  Plus,
  Loader2,
  Film,
  Search,
  LayoutGrid
} from "lucide-react";
import CreateProjectPopup from "../components/CreateProjectPopup";

const Projects = () => {
  const { user, isLoading } = useAuth0();
  const [projects, setProjects] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [instanceStatus, setInstanceStatus] = useState("checking");
  const [instanceDetails, setInstanceDetails] = useState(null);
  const [showPopup, setShowPopup] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const getUserId = useCallback(() => {
    if (user?.sub) {
      return user.sub.includes("|") ? user.sub.split("|")[1] : user.sub;
    }
    return "local_user";
  }, [user]);

  const fetchProjects = useCallback(async () => {
    setLoading(true);
    try {
      const userId = getUserId();
      const response = await axios.get(`http://localhost:8000/s3/projects/${userId}`);
      setProjects(response.data.projects || []);
      setError("");
    } catch (error) {
      console.error("Error fetching projects:", error);
      setError("Failed to load projects. Please try again later.");
    } finally {
      setLoading(false);
    }
  }, [getUserId]);

  const checkInstanceStatus = useCallback(async () => {
    try {
      const response = await axios.get("http://localhost:8000/lambda/check_instance");
      
      if (response.data.instance && response.data.instance.status === "active") {
        setInstanceStatus("running");
        setInstanceDetails(response.data.instance);
      } else if (response.data.instance && response.data.instance.status === "booting") {
        setInstanceStatus("loading");
        setInstanceDetails(response.data.instance);
      } else {
        setInstanceStatus("stopped");
        setInstanceDetails(null);
      }
    } catch (error) {
      console.error("Error checking instance status:", error);
      setInstanceStatus("stopped");
      setInstanceDetails(null);
    }
  }, []);

  const handleDelete = async (projectName) => {
    if (!projectName) {
      console.error("Missing project name");
      return;
    }

    try {
      const userId = getUserId();
      await axios.delete(`http://localhost:8000/s3/projects/${userId}/${projectName}`);
      setProjects(projects.filter((project) => project !== projectName));
    } catch (error) {
      console.error("Error deleting project:", error);
      alert("Failed to delete the project. Please try again later.");
    }
  };

  const handleStartInstance = async () => {
    setInstanceStatus("loading");
    try {
      const response = await axios.post("http://localhost:8000/lambda/start_instance");
      if (response.data.instance_status !== "launched" && 
          response.data.instance_status !== "existing") {
        console.log("instanceStatus in handleStartInstance", instanceStatus);
        // If the instance didn't start correctly, update the status
        setInstanceStatus("stopped");
        setError("Failed to start instance. Please try again later.");
      } else {
        // Success case - update to running if it's an existing instance or
        // keep as loading if it's just launched (will be updated by status check)
        if (response.data.instance_status === "existing") {
          setInstanceStatus("running");
        }
        
        // Store any available instance details
        if (response.data.instanceIP) {
          setInstanceDetails({
            ip: response.data.instanceIP,
            region: response.data.region,
            type: response.data.instanceType,
            id: response.data.instanceId
          });
        }
      }
    } catch (error) {
      console.error("Error starting instance:", error);
      setError("Failed to start instance. Please try again later. Instance capacity may be full.");
      setInstanceStatus("stopped");
    }
  };

  const handleStopInstance = async () => {
    setInstanceStatus("loading");
    try {
      await axios.post("http://localhost:8000/lambda/stop_instance");
      setInstanceStatus("stopped");
      setInstanceDetails(null);
    } catch (error) {
      console.error("Error stopping instance:", error);
      setError("Failed to stop instance. Please try again later.");
      setInstanceStatus("running");
    }
  };

  const togglePopup = () => {
    setShowPopup(!showPopup);
  };

  const handleCreateProject = async (projectName, file) => {
    await fetchProjects();
    setShowPopup(false);
  };

  // Polling mechanism for instance status
  useEffect(() => {
    if (user && user.sub) {
      checkInstanceStatus();
      fetchProjects();
      
      // Regular polling for instance status
      const statusCheckInterval = setInterval(() => {
        if (instanceStatus === "loading") {
          checkInstanceStatus();
        }
      }, 20000); // Check every 20 seconds
      
      return () => clearInterval(statusCheckInterval);
    }
  }, [user, instanceStatus, fetchProjects, checkInstanceStatus]);

  const getStatusIcon = () => {
    switch (instanceStatus) {
      case "running":
        return <CheckCircle className="w-5 h-5 text-green-500" />;
      case "loading":
        return <Clock className="w-5 h-5 text-blue-500 animate-pulse" />;
      case "checking":
        return <AlertCircle className="w-5 h-5 text-yellow-500" />;
      case "stopped":
        return <CloudOff className="w-5 h-5 text-gray-500" />;
      default:
        return <AlertCircle className="w-5 h-5 text-yellow-500" />;
    }
  };

  const getStatusColor = () => {
    switch (instanceStatus) {
      case "running":
        return "bg-green-50 border-green-200 text-green-700";
      case "loading":
        return "bg-blue-50 border-blue-200 text-blue-700";
      case "checking":
        return "bg-yellow-50 border-yellow-200 text-yellow-700";
      case "stopped":
        return "bg-gray-50 border-gray-200 text-gray-700";
      default:
        return "bg-gray-50 border-gray-200 text-gray-700";
    }
  };

  // eslint-disable-next-line no-unused-vars
  const getInstanceTypeLabel = () => {
    if (!instanceDetails || !instanceDetails.instance_type) return null;
    
    // Show the instance type if available
    return (
      <div className="text-xs flex items-center mt-1">
        <Server className="w-3 h-3 mr-1" />
        <span>{instanceDetails.instance_type.name || "GPU Instance"}</span>
      </div>
    );
  };

  // eslint-disable-next-line no-unused-vars
  const getRegionLabel = () => {
    if (!instanceDetails || !instanceDetails.region) return null;
    
    // Show the region if available
    return (
      <div className="text-xs flex items-center mt-1">
        <Cloud className="w-3 h-3 mr-1" />
        <span>{instanceDetails.region.name || "Unknown region"}</span>
      </div>
    );
  };

  // Filter projects based on search query
  const filteredProjects = projects.filter(project => 
    project.toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-10 h-10 text-teal-500 mx-auto animate-spin" />
          <p className="mt-4 text-gray-600 font-medium">Loading your account...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar />
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        <div className="bg-white rounded-xl shadow-md p-6 mb-8">
          {/* Header with instance controls */}
          <div className="flex flex-col md:flex-row md:justify-between md:items-center mb-8 gap-6">
            <div className="flex items-center">
              <Film className="w-8 h-8 text-teal-500 mr-3" />
              <h1 className="text-3xl font-bold text-gray-800">Your Projects</h1>
            </div>
            
            <div className="flex flex-col md:flex-row items-center gap-4">
              {/* Enhanced status badge */}
              <div className={`flex flex-col rounded-lg shadow-sm border px-4 py-2 ${getStatusColor()}`}>
                <div className="flex items-center">
                  {getStatusIcon()}
                  <div className="ml-2">
                    <div className="font-medium flex items-center">
                      <span>Instance:</span>
                      <span className="ml-1 capitalize">{instanceStatus === "checking" ? "Checking..." : instanceStatus === "loading" ? "Starting..." : instanceStatus}</span>
                    </div>
                    {/* {instanceStatus === "running" && (
                      <div className="flex flex-col text-xs text-gray-600">
                        {getInstanceTypeLabel()}
                        {getRegionLabel()}
                      </div>
                    )} */}
                  </div>
                </div>
              </div>
              
              {/* Enhanced action button */}
              <button
                onClick={
                  instanceStatus === "stopped" ? handleStartInstance : handleStopInstance
                }
                disabled={instanceStatus === "checking" || instanceStatus === "loading"}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors duration-200 shadow-sm ${
                  instanceStatus === "checking" || instanceStatus === "loading"
                    ? "bg-gray-300 cursor-not-allowed"
                    : instanceStatus === "stopped"
                    ? "bg-green-600 hover:bg-green-700 text-white"
                    : "bg-red-600 hover:bg-red-700 text-white"
                }`}
              >
                <Power className="w-4 h-4" />
                <span>
                  {instanceStatus === "checking"
                    ? "Checking..."
                    : instanceStatus === "loading"
                    ? "Processing..."
                    : instanceStatus === "stopped"
                    ? "Start Instance"
                    : "Stop Instance"}
                </span>
              </button>
            </div>
          </div>
          
          {/* Search and Create section */}
          <div className="flex flex-col sm:flex-row justify-between items-center mb-8 gap-4">
            <div className="relative w-full sm:w-64">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Search className="h-5 w-5 text-gray-400" />
              </div>
              <input
                type="text"
                placeholder="Search projects..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="block w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-teal-500 focus:border-teal-500"
              />
            </div>
            
            <button
              onClick={togglePopup}
              className="bg-teal-500 text-white px-4 py-2 rounded-lg flex items-center space-x-2 hover:bg-teal-600 shadow-sm transition-all duration-200 w-full sm:w-auto justify-center"
            >
              <Plus className="w-5 h-5 mr-2" />
              <span>Create New Project</span>
            </button>
          </div>

          {/* Project grid section */}
          {loading ? (
            <div className="flex justify-center items-center py-20">
              <Loader2 className="w-8 h-8 text-teal-500 animate-spin" />
              <span className="ml-3 text-gray-600">Loading projects...</span>
            </div>
          ) : error ? (
            <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 flex items-start">
              <AlertCircle className="w-5 h-5 mr-2 flex-shrink-0 mt-0.5" />
              <p>{error}</p>
            </div>
          ) : filteredProjects.length > 0 ? (
            <div>
              <div className="mb-6 flex items-center justify-between">
                <div className="flex items-center">
                  <LayoutGrid className="w-5 h-5 text-gray-500 mr-2" />
                  <h2 className="text-lg font-medium text-gray-700">
                    {filteredProjects.length} {filteredProjects.length === 1 ? 'Project' : 'Projects'} {searchQuery && `matching "${searchQuery}"`}
                  </h2>
                </div>
              </div>
              
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                {filteredProjects.map((project) => (
                  <ProjectCard
                    key={project}
                    project={project}
                    onDelete={handleDelete}
                    instanceRunning={instanceStatus === "running"}
                  />
                ))}
              </div>
            </div>
          ) : (
            <div className="py-20 text-center">
              <Film className="w-16 h-16 text-gray-300 mx-auto mb-4" />
              <h3 className="text-xl font-medium text-gray-700 mb-2">No projects found</h3>
              <p className="text-gray-500 mb-6">
                {searchQuery 
                  ? `No projects matching "${searchQuery}"`
                  : "Start creating your first 3D project"}
              </p>
              {!searchQuery && (
                <button
                  onClick={togglePopup}
                  className="bg-teal-500 text-white px-6 py-2 rounded-lg flex items-center space-x-2 hover:bg-teal-600 shadow-sm mx-auto"
                >
                  <Plus className="w-5 h-5 mr-1" />
                  <span>Create First Project</span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* Help card */}
        <div className="bg-gradient-to-r from-teal-500 to-teal-600 rounded-xl shadow-md p-6 text-white">
          <h2 className="text-xl font-semibold mb-2">Getting Started</h2>
          <p className="mb-4">Turn your videos into interactive 3D models in just a few steps.</p>
          <ol className="list-decimal list-inside space-y-2 mb-4">
            <li>Start the GPU instance using the button above</li>
            <li>Create a new project and upload your video</li>
            <li>Train your 3D model</li>
            <li>View and share your interactive 3D rendering</li>
          </ol>
          <p className="text-sm text-teal-100">
            Remember to stop your instance when you're done to save resources.
          </p>
        </div>
      </div>

      <CreateProjectPopup
        isOpen={showPopup}
        onClose={togglePopup}
        onCreate={handleCreateProject}
      />
    </div>
  );
};

export default Projects;
