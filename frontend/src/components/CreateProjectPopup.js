import React, { useState, useEffect, useCallback, useRef } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import axios from "axios";

const CreateProjectPopup = ({ isOpen, onClose, onCreate }) => {
  const { user } = useAuth0();
  const [projectName, setProjectName] = useState("");
  const [file, setFile] = useState(null);
  const [uploadMessage, setUploadMessage] = useState("");
  const [existingProjects, setExistingProjects] = useState([]);
  const [errorMessage, setErrorMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const fileInputRef = useRef(null);

  const fetchExistingProjects = useCallback(async () => {
    try {
      const userId = user?.sub ? (user.sub.includes('|') ? user.sub.split('|')[1] : user.sub) : 'local_user';
      const response = await axios.get(
        `http://localhost:8000/s3/projects/${userId}`
      );
      setExistingProjects(response.data.projects || []);
    } catch (error) {
      console.error("Error fetching existing projects:", error);
      setExistingProjects([]);
    }
  }, [user?.sub]);

  useEffect(() => {
    if (isOpen) {
      fetchExistingProjects();
    }
  }, [isOpen, fetchExistingProjects]);

  const handleFileChange = (e) => {
    const selectedFile = e.target.files[0];
    if (!selectedFile) return;

    const validExtensions = [".mp4", ".mov", ".avi", ".mkv", ".webm", ".zip"];
    const isSupported = validExtensions.some((ext) =>
      selectedFile.name.toLowerCase().endsWith(ext)
    );

    if (isSupported) {
      setFile(selectedFile);
      setUploadMessage("");
      setErrorMessage("");
    } else {
      setFile(null);
      setErrorMessage("Please upload a video file (.mp4, .mov, .avi) or .zip archive.");
    }
  };

  const triggerFileInput = () => {
    fileInputRef.current.click();
  };

  const handleFormSubmit = async (e) => {
    e.preventDefault();

    if (!projectName || !file) {
      setErrorMessage("Please fill out all fields.");
      return;
    }

    if (!/^[A-Za-z0-9_]+$/.test(projectName)) {
      setErrorMessage(
        "Project name should only contain letters, numbers, and underscores (no spaces)."
      );
      return;
    }

    // Check for duplicate project name
    if (existingProjects.includes(projectName)) {
      setErrorMessage(
        "A project with this name already exists. Please choose a different name."
      );
      return;
    }

    // Set loading state to true
    setIsSubmitting(true);

    // Preserve original extension (.mp4, .mov, .zip, etc.)
    const ext = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : 'mp4';
    const renamedFile = new File([file], `${projectName}.${ext}`, {
      type: file.type,
    });

    const userId = user?.sub ? (user.sub.includes('|') ? user.sub.split('|')[1] : user.sub) : 'local_user';
    const formData = new FormData();
    formData.append("file", renamedFile);
    formData.append("projectName", projectName);
    formData.append("userId", userId);

    try {
      const response = await axios.post(
        "http://localhost:8000/s3/upload",
        formData,
        {
          headers: {
            "Content-Type": "multipart/form-data",
          },
        }
      );

      setUploadMessage(response.data.message || "File uploaded successfully!");
      console.log("File uploaded:", response.data);

      // Notify parent component of the new project
      onCreate(projectName, response.data);

      // Reset form fields
      setProjectName("");
      setFile(null);
      setUploadMessage("");
      setErrorMessage("");
      onClose();
    } catch (error) {
      console.error("Error uploading file:", error);
      setUploadMessage("Error uploading file. Check the console for details.");
      setErrorMessage(`Upload failed: ${error.message || "Unknown error"}`);
    } finally {
      // Set loading state to false regardless of outcome
      setIsSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black bg-opacity-50">
      <div className="bg-white rounded-lg shadow-lg p-8 w-full max-w-2xl mx-4">
        <h2 className="text-2xl font-semibold mb-6">Create New Project</h2>
        <form onSubmit={handleFormSubmit}>
          <div className="mb-6">
            <label
              htmlFor="projectName"
              className="block text-gray-700 font-medium mb-2"
            >
              Project Name
            </label>
            <input
              type="text"
              id="projectName"
              value={projectName}
              onChange={(e) => {
                setProjectName(e.target.value);
                setErrorMessage(""); // Clear error message on input change
              }}
              className="w-full border border-gray-300 rounded-lg shadow-sm p-3 focus:ring-teal-500 focus:border-teal-500"
              placeholder="Enter project name (use underscores instead of spaces)"
              disabled={isSubmitting}
            />
          </div>
          {errorMessage && (
            <p className="text-red-500 text-sm mb-4">{errorMessage}</p>
          )}
          <div className="mb-6">
            <label
              htmlFor="fileUpload"
              className="block text-gray-700 font-medium mb-2"
            >
              Upload Drone Video (.mp4, .mov) or Dataset (.zip)
            </label>
            <div 
              className="border border-dashed border-gray-300 rounded-lg p-8 flex flex-col items-center justify-center cursor-pointer hover:bg-gray-50 transition-colors"
              onClick={triggerFileInput}
            >
              <input
                type="file"
                id="fileUpload"
                accept=".mp4,.mov,.avi,.mkv,.zip"
                onChange={handleFileChange}
                className="hidden"
                disabled={isSubmitting}
                ref={fileInputRef}
              />
              
              <div className="text-center">
                {file ? (
                  <div className="flex flex-col items-center">
                    <div className="mb-2 text-teal-600">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    </div>
                    <p className="text-gray-700 font-medium">{file.name}</p>
                    <p className="text-gray-500 text-sm mt-1">
                      {(file.size / (1024 * 1024)).toFixed(2)} MB
                    </p>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setFile(null);
                      }}
                      className="mt-2 text-sm text-red-500 hover:text-red-700"
                      disabled={isSubmitting}
                    >
                      Remove file
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col items-center">
                    <div className="mb-2 text-gray-400">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                      </svg>
                    </div>
                    <p className="text-gray-700 font-medium">Drag and drop your file here or click to browse</p>
                    <p className="text-gray-500 text-sm mt-1">
                      Upload your drone video (.mp4, .mov) or dataset (.zip)
                    </p>
                    <button
                      type="button"
                      className="mt-4 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 focus:outline-none focus:ring-2 focus:ring-teal-500"
                      disabled={isSubmitting}
                    >
                      Choose File
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="flex justify-end space-x-4 mt-8">
            <button
              type="button"
              onClick={onClose}
              className="bg-gray-300 text-gray-700 px-6 py-3 rounded-lg hover:bg-gray-400 font-medium"
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className={`flex items-center justify-center bg-teal-500 text-white px-6 py-3 rounded-lg transition-colors duration-200 font-medium ${
                isSubmitting ? 'opacity-70 cursor-not-allowed' : 'hover:bg-teal-600'
              }`}
              style={{ minWidth: '120px' }}
            >
              {isSubmitting ? (
                <>
                  <svg className="animate-spin -ml-1 mr-2 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  Creating...
                </>
              ) : "Create"}
            </button>
          </div>
        </form>
        {uploadMessage && !errorMessage && (
          <p className="mt-6 text-center text-green-500 font-medium">{uploadMessage}</p>
        )}
      </div>
    </div>
  );
};

export default CreateProjectPopup;
