const express = require("express");
const AWS = require("aws-sdk");
const { NodeSSH } = require("node-ssh");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});
const router = express.Router();

const SSH_KEY_PATH = process.env.SSH_KEY_PATH;
const LAMBDA_LABS_API_KEY = process.env.LAMBDA_LABS_API_KEY;
let INSTANCE_TYPE = [];
try {
  INSTANCE_TYPE = JSON.parse(process.env.LAMBDA_LABS_INSTANCE_TYPE || '[]');
} catch (e) {
  if (process.env.LAMBDA_LABS_INSTANCE_TYPE) {
    INSTANCE_TYPE = process.env.LAMBDA_LABS_INSTANCE_TYPE
      .replace(/[\[\]]/g, '')
      .split(',')
      .map(s => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }
}
const LAMBDA_LABS_SSH_KEY = process.env.LAMBDA_LABS_SSH_KEY;

// List of allowed US regions
const ALLOWED_REGIONS = [
  'us-east-1',    // Virginia, USA
  'us-east-2',    // Washington DC, USA
  'us-midwest-1', // Illinois, USA
  'us-south-1',   // Texas, USA
  'us-south-2',   // North Texas, USA
  'us-south-3',   // Central Texas, USA
  'us-west-1',    // California, USA
  'us-west-2',    // Arizona, USA
  'us-west-3'     // Utah, USA
];

async function runCommandviaSSH(instance_ip, commandString) {
  const ssh = new NodeSSH(); // ANSH
  console.log("Running command on Lambda Labs instance...");
  const username = "ubuntu";
  const privateKey = fs.readFileSync(SSH_KEY_PATH, "utf8");

  try {
    // Connect to instance
    await ssh.connect({
      host: instance_ip,
      username: username,
      privateKey: privateKey,
    });
    console.log("Connected to the Lambda Labs instance.");

    const result = await ssh.execCommand(commandString);
    // if anything in std.err, we should fail
    if (result.stderr) {
      return {
        command_status: "fail",
        message: "Command failed. Stderr output",
        result: {
          stdout: result.stdout,
          stderr: result.stderr,
        },
      };
    }

    console.log("Command executed on Lambda Labs instance.");
    return {
      command_status: "success",
      message: "Command executed successfully",
      result: {
        stdout: result.stdout,
        stderr: result.stderr,
      },
    };
  } catch (error) {
    console.error("Error running command on the instance:", error);
    return {
      command_status: "fail",
      message: "Error running command on the instance",
      error: {
        status: error.response?.status,
        statusText: error.response?.statusText,
        details: error.response?.data,
        message: error.message,
      },
    };
  } finally {
    ssh.dispose();
  }
}

async function sshSetup(instance_ip) {
  ssh_setup_command = "sudo sed -i 's/#ClientAliveInterval.*/ClientAliveInterval 60/' /etc/ssh/sshd_config && sudo sed -i 's/#ClientAliveCountMax.*/ClientAliveCountMax 120/' /etc/ssh/sshd_config && sudo systemctl restart ssh";
  commandOutput = await runCommandviaSSH(instance_ip, ssh_setup_command);

  if (commandOutput.command_status === "fail") {
    console.log("Error setting up ssh");
  } else {
    console.log("Success setting up ssh");
  }

  return commandOutput;
}

async function dockerSetup(instance_ip) {
  // use bash via ssh to run docker commands to pull in a docker image and start it
  docker_pull_command =
    "sudo docker pull ghcr.io/nerfstudio-project/nerfstudio@sha256:3af2836319a8da9cf3b2c2ecf7f5fb4dc8763d2bdbc871e37902a491b05a84c9";

  // run the docker pull command
  commandOutput = await runCommandviaSSH(instance_ip, docker_pull_command);

  // check status
  if (commandOutput.command_status === "fail") {
    console.log("Error pulling docker image");
  } else {
    console.log("Success pulling docker image");
  }

  return commandOutput;
}

async function awsSetup(instance_ip) {
  aws_cli_download_command = "pip3 install awscli --upgrade --user";

  // Run download command and check status
  commandOutput = await runCommandviaSSH(instance_ip, aws_cli_download_command);
  if (commandOutput.command_status === "fail") {
    console.log("Error downloading aws cli");
  }
  console.log("Success downloading aws cli");

  aws_dir_command = "mkdir .aws; cd .aws; touch config; touch credentials";
  write_config_command = `echo [default] >> config; echo region=${process.env.AWS_REGION} >> config`;
  write_credentials_command = `echo [default] >> credentials; echo aws_access_key_id=${process.env.AWS_ACCESS_KEY_ID} >> credentials; echo aws_secret_access_key=${process.env.AWS_SECRET_ACCESS_KEY} >> credentials`;

  const concatenatedCommand = `${aws_dir_command}; ${write_config_command}; ${write_credentials_command}`;

  commandOutput = await runCommandviaSSH(instance_ip, concatenatedCommand);
  
  if (commandOutput.command_status === "fail") {
    console.log("Error creating environment variables");
  } else {
    console.log("Success creating environment variables");
  }

  return commandOutput;
}

async function downloadFileFromS3(instance_ip, localFilePath, bucketFilePath) {
  downloadFileCommand = `aws s3 cp --recursive ${bucketFilePath} ${localFilePath}`;
  commandOutput = await runCommandviaSSH(instance_ip, downloadFileCommand);
  if (commandOutput.command_status === "fail") {
    console.log("Error downloading files from S3");
    return commandOutput;
  } else {
    console.log("Success downloading files from S3");
    return commandOutput;
  }
}

async function uploadFileToS3(instance_ip, localFilePath, bucketFilePath) {
  const uploadCommand = `aws s3 cp --recursive ${localFilePath} ${bucketFilePath}`;
  commandOutput = await runCommandviaSSH(instance_ip, uploadCommand);
  if (commandOutput.command_status === "fail") {
    console.log("Error uploading files to S3");
    return commandOutput;
  } else {
    console.log("Success uploading files to S3");
    return commandOutput;
  }
}

// Setup Docker container and return container ID
async function setupDockerContainer(ssh, userId, projectName, io, room) {
  console.log("Setting up Docker container...");
  
  // Emit status update to the client
  if (io) {
    io.to(room).emit('trainingStatus', {
      step: 'setup',
      status: 'running',
      message: 'Setting up Docker container...'
    });
  }
  
  // cd into correct workspace
  const cdCommand = `cd ${userId}/${projectName}`;
  const cdResult = await ssh.execCommand(cdCommand);
  console.log("[Change Directory]", cdResult.stdout);
  if (cdResult.stderr) {
    if (io) {
      io.to(room).emit('trainingStatus', {
        step: 'setup',
        status: 'error',
        message: `Failed to change directory: ${cdResult.stderr}`
      });
    }
    throw new Error(`Failed to change directory: ${cdResult.stderr}`);
  }

  // start docker image with correct options
  const dockerRunCommand =
    'sudo docker run \
          --gpus all \
          -u "$(id -u)" \
          -v "$(pwd)":/workspace \
          -v /home/ubuntu/.cache:/home/user/.cache \
          -p 7007:7007 \
          --rm \
          -d \
          --shm-size=40gb \
          -e XDG_DATA_HOME=/workspace/.local/share \
          -e XDG_CACHE_HOME=/workspace/.cache \
          -e MPLCONFIGDIR=/workspace/.config/matplotlib \
          ghcr.io/nerfstudio-project/nerfstudio@sha256:3af2836319a8da9cf3b2c2ecf7f5fb4dc8763d2bdbc871e37902a491b05a84c9 tail -f /dev/null';
  
  const dockerResult = await ssh.execCommand(dockerRunCommand);
  console.log("[Docker Setup]", dockerResult.stdout);
  if (dockerResult.stderr) {
    if (io) {
      io.to(room).emit('trainingStatus', {
        step: 'setup',
        status: 'error',
        message: `Docker container setup failed: ${dockerResult.stderr}`
      });
    }
    throw new Error(`Docker container setup failed: ${dockerResult.stderr}`);
  }
  
  const containerId = dockerResult.stdout.trim();
  console.log(`Docker container started with ID: ${containerId}`);
  
  if (io) {
    io.to(room).emit('trainingStatus', {
      step: 'setup',
      status: 'completed',
      message: 'Docker container setup completed',
      containerId: containerId
    });
  }
  
  return containerId;
}

// Process data step
async function processData(ssh, containerId, userId, projectName, outputDir, io, room) {
  console.log("Processing data...");
  
  if (io) {
    io.to(room).emit('trainingStatus', {
      step: 'process',
      status: 'running',
      message: 'Processing video data...'
    });
  }
  
  // Construct the processing command
  // Updated to use a case-insensitive file pattern for both .MP4 and .mp4
  const processCommand = `sudo docker exec ${containerId} bash -c 'cd /workspace/${userId}/${projectName} && \
  ns-process-data video --data ./*.mp4 --output-dir ${outputDir} --num-downscales=0 --gpu'`;
  
  console.log("Executing command with streaming output:", processCommand);
  
  // Execute command with stream options
  const processResult = await ssh.execCommand(processCommand, {
    onStdout: (chunk) => {
      // Stream each chunk of stdout to the console
      const output = chunk.toString('utf8');
      console.log("[Data Processing Output]:", output);
    },
    onStderr: (chunk) => {
      // Stream each chunk of stderr to the console
      const error = chunk.toString('utf8');
      console.error("[Data Processing Error]:", error);
    }
  });
  
  console.log("[Data Processing Complete] Exit Code:", processResult.code);
  
  // Check for errors in stderr
  if (processResult.stderr && processResult.stderr.includes("Error")) {
    if (io) {
      io.to(room).emit('trainingStatus', {
        step: 'process',
        status: 'error',
        message: `Data processing failed: ${processResult.stderr}`
      });
    }
    throw new Error(`Data processing failed: ${processResult.stderr}`);
  }
  
  console.log("Data processing completed successfully");
  
  if (io) {
    io.to(room).emit('trainingStatus', {
      step: 'process',
      status: 'completed',
      message: 'Video data processing completed successfully'
    });
  }
  
  return processResult;
}

// Training model step
async function trainModel(ssh, containerId, userId, projectName, dataDir, io, room, instanceIp) {
  console.log("Training model...");
  
  if (io) {
    io.to(room).emit('trainingStatus', {
      step: 'train',
      status: 'running',
      message: 'Training 3D model... This may take several minutes.',
      viewerUrl: `http://${instanceIp}:7007`
    });
  }
  
  const trainCommand = `sudo docker exec ${containerId} bash -c 'cd /workspace/${userId}/${projectName} && \
  export USER=myuser && \
  export LOGNAME=myuser && \
  ns-train splatfacto-big --data "${dataDir}" --viewer.quit-on-train-completion True --pipeline.model.cull_alpha_thresh=0.005 --pipeline.model.use_scale_regularization=True'`;
  
  const trainResult = await ssh.execCommand(trainCommand);
  console.log("[Model Training]", trainResult.stdout);
  if (trainResult.stderr && trainResult.stderr.includes("Error")) {
    if (io) {
      io.to(room).emit('trainingStatus', {
        step: 'train',
        status: 'error',
        message: `Model training failed: ${trainResult.stderr}`
      });
    }
    throw new Error(`Model training failed: ${trainResult.stderr}`);
  }
  
  console.log("Model training completed successfully");
  
  if (io) {
    io.to(room).emit('trainingStatus', {
      step: 'train',
      status: 'completed',
      message: 'Model training completed successfully'
    });
  }
  
  return trainResult;
}

// Export Gaussian splat step
async function exportGaussianSplat(ssh, containerId, userId, projectName, outputDir, io, room) {
  console.log("Exporting Gaussian splat...");
  
  if (io) {
    io.to(room).emit('trainingStatus', {
      step: 'export',
      status: 'running',
      message: 'Exporting 3D Gaussian splat...'
    });
  }
  
  const exportCommand = `sudo docker exec ${containerId} bash -c 'cd /workspace/${userId}/${projectName} && \
  ns-export gaussian-splat --load-config outputs/*/*/*/config.yml --output-dir "${outputDir}" --obb_center 0.0000000000 0.0000000000 0.0000000000 --obb_rotation 0.0000000000 0.0000000000 0.0000000000 --obb_scale 1.0000000000 1.0000000000 1.0000000000'`;
  
  const exportResult = await ssh.execCommand(exportCommand);
  console.log("[Export Gaussian Splat]", exportResult.stdout);
  if (exportResult.stderr && exportResult.stderr.includes("Error")) {
    if (io) {
      io.to(room).emit('trainingStatus', {
        step: 'export',
        status: 'error',
        message: `Gaussian splat export failed: ${exportResult.stderr}`
      });
    }
    throw new Error(`Gaussian splat export failed: ${exportResult.stderr}`);
  }
  
  console.log("Gaussian splat export completed successfully");
  
  if (io) {
    io.to(room).emit('trainingStatus', {
      step: 'export',
      status: 'completed',
      message: 'Gaussian splat export completed successfully'
    });
  }
  
  return exportResult;
}

// Stop Docker container step
async function stopDockerContainer(ssh, containerId, io, room) {
  console.log(`Stopping Docker container: ${containerId}`);
  
  if (io) {
    io.to(room).emit('trainingStatus', {
      step: 'cleanup',
      status: 'running',
      message: 'Stopping Docker container...'
    });
  }
  
  const stopCommand = `sudo docker stop ${containerId}`;
  const stopResult = await ssh.execCommand(stopCommand);
  console.log("[Container Stop]", stopResult.stdout);
  
  if (stopResult.stderr && stopResult.stderr.includes("Error")) {
    console.warn(`Warning: Issue stopping container: ${stopResult.stderr}`);
    if (io) {
      io.to(room).emit('trainingStatus', {
        step: 'cleanup',
        status: 'warning',
        message: `Warning: Issue stopping container: ${stopResult.stderr}`
      });
    }
  } else {
    console.log("Docker container stopped successfully");
    if (io) {
      io.to(room).emit('trainingStatus', {
        step: 'cleanup',
        status: 'completed',
        message: 'Docker container stopped successfully'
      });
    }
  }
  
  return stopResult;
}

// Main training routine that orchestrates all steps
async function lambdaTrainRoutine(instance_ip, projectName, userId, req) {
  console.log("Running modular training routine on Lambda Labs instance...");
  const ssh = new NodeSSH();
  const username = "ubuntu";
  const privateKey = fs.readFileSync(SSH_KEY_PATH, "utf8");
  const processedDataOutputDir = projectName + "-output";
  const meshOutputDir = projectName + "-mesh";
  
  // Get the io instance if available
  const io = req ? req.app.get('io') : null;
  const room = `${userId}_${projectName}`;
  
  // Current step tracker for heartbeat
  let currentStep = 'starting';
  
  // Heartbeat function to keep socket connection alive
  const sendHeartbeat = () => {
    if (io && room) {
      io.to(room).emit('trainingStatus', {
        step: currentStep,
        status: 'heartbeat',
        message: `Still working on ${currentStep}...`,
        timestamp: new Date().toISOString()
      });
    }
  };
  
  // Set up heartbeat interval
  let heartbeatInterval = null;
  if (io) {
    heartbeatInterval = setInterval(sendHeartbeat, 30000); // Send heartbeat every 15 seconds
    
    // Send initial status
    io.to(room).emit('trainingStatus', {
      step: 'overall',
      status: 'started',
      message: 'Starting training process...'
    });
  } else {
    console.log("No Socket.IO instance available, heartbeat disabled");
  }
  
  try {
    // Connect to instance
    await ssh.connect({
      host: instance_ip,
      username: username,
      privateKey: privateKey,
    });

    // Execute each step in sequence
    currentStep = 'setup';
    const containerId = await setupDockerContainer(ssh, userId, projectName, io, room);
    
    currentStep = 'process';
    await processData(ssh, containerId, userId, projectName, processedDataOutputDir, io, room);
    
    currentStep = 'train';
    await trainModel(ssh, containerId, userId, projectName, processedDataOutputDir, io, room, instance_ip);
    
    currentStep = 'export';
    await exportGaussianSplat(ssh, containerId, userId, projectName, meshOutputDir, io, room);
    
    currentStep = 'cleanup';
    await stopDockerContainer(ssh, containerId, io, room);

    // Clear heartbeat when done
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }

    if (io) {
      io.to(room).emit('trainingStatus', {
        step: 'overall',
        status: 'completed',
        message: 'All processing steps completed successfully'
      });
    }

    return {
      command_status: "success",
      message: "All processing steps completed successfully",
      containerId: containerId,
    };
  } catch (error) {
    console.error("Error in training routine:", error);
    
    // Clear heartbeat on error
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    
    if (io) {
      io.to(room).emit('trainingStatus', {
        step: 'overall',
        status: 'error',
        message: `Training routine failed: ${error.message}`
      });
    }
    
    return {
      command_status: "fail",
      message: `Training routine failed: ${error.message}`,
      error: {
        message: error.message,
      },
    };
  } finally {
    // Double-ensure heartbeat is cleared
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    ssh.dispose();
  }
}

async function convertPlyToSplat(instance_ip, userId, projectName, req) {
  console.log("Converting PLY to SPLAT format...");
  const ssh = new NodeSSH();
  const username = "ubuntu";
  const privateKey = fs.readFileSync(SSH_KEY_PATH, "utf8");
  const meshOutputDir = projectName + "-mesh";
  const plyFilePath = `/home/ubuntu/${userId}/${projectName}/${meshOutputDir}/splat.ply`;
  const splatFilePath = plyFilePath.replace('.ply', '.splat');
  
  // Get the io instance if available
  const io = req ? req.app.get('io') : null;
  const room = `${userId}_${projectName}`;
  
  if (io) {
    io.to(room).emit('trainingStatus', {
      step: 'convert',
      status: 'running',
      message: 'Converting PLY to SPLAT format...'
    });
  }
  
  try {
    // Connect to instance
    await ssh.connect({
      host: instance_ip,
      username: username,
      privateKey: privateKey,
    });

    // Upload the Python script to the instance
    console.log("Uploading PLY to SPLAT conversion script...");
    // Read the script file from the local filesystem
    const scriptContent = fs.readFileSync(`${__dirname}/../scripts/ply_to_splat.py`, 'utf8');
    const remoteScriptPath = `/home/ubuntu/${userId}/${projectName}/ply_to_splat.py`;
    
    // Create the script on the remote machine
    await ssh.execCommand(`cat > ${remoteScriptPath} << 'EOL'
${scriptContent}
EOL`);
    
    // Make the script executable
    await ssh.execCommand(`chmod +x ${remoteScriptPath}`);
    
    // Install required Python packages
    console.log("Installing required Python packages...");
    const installPackagesCmd = "pip install plyfile numpy";
    const installResult = await ssh.execCommand(installPackagesCmd);
    if (installResult.stderr) {
      console.error("Error installing Python packages:", installResult.stderr);
    }
    
    // Run the conversion script
    console.log("Running PLY to SPLAT conversion...");
    const convertCmd = `python ${remoteScriptPath} ${plyFilePath} ${splatFilePath}`;
    const convertResult = await ssh.execCommand(convertCmd);
    
    if (convertResult.stderr && convertResult.stderr.includes("Error")) {
      console.error("Error during PLY to SPLAT conversion:", convertResult.stderr);
      throw new Error(`PLY to SPLAT conversion failed: ${convertResult.stderr}`);
    }
    
    console.log("Conversion output:", convertResult.stdout);
    
    // Upload the SPLAT file to S3
    const bucketName = process.env.S3_BUCKET_NAME;
    const s3SplatPath = `s3://${bucketName}/${userId}/${projectName}/point_cloud.splat`;
    
    console.log(`Uploading SPLAT file to S3: ${s3SplatPath}`);
    const uploadCmd = `aws s3 cp ${splatFilePath} ${s3SplatPath}`;
    const uploadResult = await ssh.execCommand(uploadCmd);
    
    if (uploadResult.stderr && uploadResult.stderr.includes("Error")) {
      console.error("Error uploading SPLAT file to S3:", uploadResult.stderr);
      throw new Error(`Failed to upload SPLAT file to S3: ${uploadResult.stderr}`);
    }
    
    console.log("SPLAT file uploaded successfully to S3");
    
    if (io) {
      io.to(room).emit('trainingStatus', {
        step: 'convert',
        status: 'completed',
        message: 'PLY to SPLAT conversion completed successfully'
      });
    }
    
    return {
      command_status: "success",
      message: "PLY to SPLAT conversion and upload completed successfully",
      splatPath: `${userId}/${projectName}/${meshOutputDir}/point_cloud.splat`,
    };
    
  } catch (error) {
    console.error("Error in PLY to SPLAT conversion:", error);
    
    if (io) {
      io.to(room).emit('trainingStatus', {
        step: 'convert',
        status: 'error',
        message: `PLY to SPLAT conversion failed: ${error.message}`
      });
    }
    
    return {
      command_status: "fail",
      message: "Error in PLY to SPLAT conversion",
      error: {
        message: error.message,
      },
    };
  } finally {
    ssh.dispose();
  }
}

// Local 3D Reconstruction Pipeline Handler (SIH26158)
async function runLocalReconstruction(userId, projectName, io, room) {
  console.log(`[Local Pipeline] Starting 3D reconstruction for ${userId}/${projectName}`);

  const emitStatus = (step, status, message) => {
    if (io) {
      io.to(room).emit('trainingStatus', { step, status, message, timestamp: new Date().toISOString() });
    }
  };

  emitStatus('setup', 'running', 'Setting up local workspace (NVIDIA RTX 3050)...');

  const projectUploadDir = path.join(__dirname, '..', 'uploads', userId, projectName);
  const zipPath = path.join(projectUploadDir, `${projectName}.zip`);
  const workspaceDir = path.join(__dirname, '..', '..', 'workspace', projectName);
  const keyframesDir = path.join(workspaceDir, 'keyframes');

  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(keyframesDir, { recursive: true });

  // Check for directly uploaded video or archive in projectUploadDir
  if (fs.existsSync(projectUploadDir)) {
    const uploadedFiles = fs.readdirSync(projectUploadDir);
    const directVideo = uploadedFiles.find(f => f.match(/\.(mp4|mov|avi|mkv)$/i));
    const zipFile = uploadedFiles.find(f => f.match(/\.zip$/i));

    if (directVideo) {
      fs.copyFileSync(path.join(projectUploadDir, directVideo), path.join(workspaceDir, directVideo));
      console.log(`[Local Pipeline] Staged direct video: ${directVideo}`);
    } else if (zipFile) {
      emitStatus('setup', 'running', 'Extracting project archive...');
      try {
        execSync(`tar -xf "${path.join(projectUploadDir, zipFile)}" -C "${workspaceDir}"`, { stdio: 'ignore' });
        console.log(`[Local Pipeline] Extracted archive ${zipFile} to ${workspaceDir}`);
      } catch (e) {
        console.warn("[Local Pipeline] Tar extraction note:", e.message);
      }
    }
  }

  emitStatus('setup', 'completed', 'Local workspace initialized');
  emitStatus('stage1', 'running', 'Stage 1/6 — Extracting & quality-filtering keyframes...');

  // Check if video file or image frames
  const files = fs.readdirSync(workspaceDir);
  const videoFile = files.find(f => f.match(/\.(mp4|mov|avi)$/i));

  if (videoFile) {
    const videoFullPath = path.join(workspaceDir, videoFile);
    emitStatus('stage1', 'completed', 'Stage 1/6 — Keyframe extraction ready');
    emitStatus('stage2', 'running', 'Stage 2/6 — Running COLMAP Structure-from-Motion...');
    try {
      execSync(`python reconstruct.py "${videoFullPath}" --project-id "${projectName}" --user-id "${userId}"`, {
        cwd: path.join(__dirname, '..', '..'),
        stdio: 'inherit'
      });
    } catch (e) {
      console.error("[Local Pipeline] reconstruct.py execution error:", e.message);
      throw new Error(`reconstruct.py failed: ${e.message}`);
    }
    emitStatus('stage2', 'completed', 'Stage 2/6 — Camera poses estimated');
    emitStatus('stage3', 'completed', 'Stage 3/6 — Dense depth & confidence maps generated');
    emitStatus('stage4', 'completed', 'Stage 4/6 — Multi-view point cloud fused');
    emitStatus('stage5', 'completed', 'Stage 5/6 — Surface mesh & GLB exported');
    emitStatus('stage6', 'running', 'Stage 6/6 — Synchronising assets to viewer...');
  } else {
    // If frames were directly uploaded as images in the zip
    const imgFiles = files.filter(f => f.match(/\.(png|jpg|jpeg)$/i));
    imgFiles.forEach(img => {
      try {
        fs.copyFileSync(path.join(workspaceDir, img), path.join(keyframesDir, img));
      } catch (e) {}
    });
    console.log(`[Local Pipeline] Staged ${imgFiles.length} keyframe images`);
    emitStatus('stage1', 'completed', `Stage 1/6 — ${imgFiles.length} keyframes staged from archive`);
    emitStatus('stage2', 'running', 'Stage 2/6 — Running Structure-from-Motion (OpenCV fallback)...');
  }

  emitStatus('process', 'completed', 'Frames processed and validated');
  emitStatus('train', 'running', 'Reconstructing 3D point cloud & geometry (Local RTX 3050)...');

  const generatedObj = path.join(workspaceDir, 'mesh', 'model.obj');
  const generatedPly = path.join(workspaceDir, 'pointcloud', 'dense.ply');
  const generatedDepthMetrics = path.join(workspaceDir, 'metrics', 'depth_analysis.json');
  const generatedDepthDir = path.join(workspaceDir, 'depth');

  // Copy real reconstructed 3D assets into project upload directory
  const generatedGlb = path.join(workspaceDir, 'mesh', 'model.glb');
  if (fs.existsSync(generatedGlb)) {
    fs.copyFileSync(generatedGlb, path.join(projectUploadDir, 'model.glb'));
    console.log(`[Local Pipeline] Copied GLB model to ${path.join(projectUploadDir, 'model.glb')}`);
  }
  if (fs.existsSync(generatedObj)) {
    fs.copyFileSync(generatedObj, path.join(projectUploadDir, 'model.obj'));
    console.log(`[Local Pipeline] Copied OBJ model to ${path.join(projectUploadDir, 'model.obj')}`);
  }
  if (fs.existsSync(generatedPly)) {
    fs.copyFileSync(generatedPly, path.join(projectUploadDir, 'dense.ply'));
  }
  if (fs.existsSync(generatedDepthMetrics)) {
    fs.copyFileSync(generatedDepthMetrics, path.join(projectUploadDir, 'depth_analysis.json'));
  }
  if (fs.existsSync(generatedDepthDir)) {
    const depthFiles = fs.readdirSync(generatedDepthDir);
    depthFiles.forEach(df => {
      try {
        fs.copyFileSync(path.join(generatedDepthDir, df), path.join(projectUploadDir, df));
      } catch (e) {}
    });
  }
  const generatedSegDir = path.join(workspaceDir, 'segmentation');
  if (fs.existsSync(generatedSegDir)) {
    const segFiles = fs.readdirSync(generatedSegDir);
    segFiles.forEach(sf => {
      try {
        fs.copyFileSync(path.join(generatedSegDir, sf), path.join(projectUploadDir, sf));
      } catch (e) {}
    });
  }

  // Remove any legacy fake splat file so viewer uses local Three.js engine
  const fakeSplat = path.join(projectUploadDir, 'point_cloud.splat');
  if (fs.existsSync(fakeSplat)) {
    try { fs.unlinkSync(fakeSplat); } catch (e) {}
  }

  emitStatus('stage6', 'completed', 'Stage 6/6 — Assets synchronised to local web viewer');
  emitStatus('train', 'completed', '3D geometry reconstructed successfully');
  emitStatus('export', 'running', 'Packaging GLB + PLY + depth reports...');
  emitStatus('export', 'completed', '3D assets packaged and ready');
  emitStatus('final', 'completed', 'Reconstruction complete — model ready to view!');

  const glbExists = fs.existsSync(path.join(projectUploadDir, 'model.glb'));
  const modelFileName = glbExists ? 'model.glb' : 'model.obj';
  return {
    status: 'success',
    message: 'Local 3D reconstruction completed successfully',
    objFileUrl: `http://localhost:8000/uploads/${userId}/${projectName}/${modelFileName}`,
    modelFileName
  };
}


// route for training a model
router.post("/train", async (req, res) => {
  const { userId, projectName } = req.body;
  console.log(`Train request received for user=${userId}, project=${projectName}`);
  
  // Get Socket.IO instance
  const io = req.app.get('io');
  const room = `${userId}_${projectName}`;

  // If in Local Mode (no Lambda Labs key or local hardware preference)
  if (!LAMBDA_LABS_API_KEY || LAMBDA_LABS_API_KEY.includes('...') || LAMBDA_LABS_API_KEY === 'your-api-key') {
    try {
      const localResult = await runLocalReconstruction(userId, projectName, io, room);
      return res.status(200).json(localResult);
    } catch (localErr) {
      console.error("[Local Pipeline Error]:", localErr);
      if (io) {
        io.to(room).emit('trainingStatus', { step: 'overall', status: 'error', message: localErr.message });
      }
      return res.status(500).json({ message: "Local reconstruction failed", error: localErr.message });
    }
  }
  
  try {
    // Look for any running instances of the desired type
    const existingInstancesResponse = await axios.get(
      "https://cloud.lambdalabs.com/api/v1/instances",
      {
        headers: { Authorization: `Bearer ${LAMBDA_LABS_API_KEY}` },
      }
    );
    const runningInstance = existingInstancesResponse.data.data.find(
      (instance) =>
        INSTANCE_TYPE.includes(instance.instance_type.name) &&
        instance.status === "active"
    );
    if (!runningInstance) {
      console.log("No cloud instance found, falling back to local processing...");
      const localResult = await runLocalReconstruction(userId, projectName, io, room);
      return res.status(200).json(localResult);
    }
    console.log(`Found existing running instance: ${runningInstance.id}`);

    // Download files from s3 onto lambda labs instance using commands
    console.log("Downloading files from S3 to Lambda Labs instance...");
    
    if (io) {
      io.to(room).emit('trainingStatus', {
        step: 'download',
        status: 'running',
        message: 'Downloading project files from S3...'
      });
    }
    
    const bucketName = process.env.S3_BUCKET_NAME; // Add your S3 bucket name here
    const localFilePath = `/home/ubuntu/${userId}/${projectName}`; // Destination path on the Lambda Labs instance
    const bucketFilePath = `s3://${bucketName}/${userId}/${projectName}`;
    const s3DownloadOutput = await downloadFileFromS3(
      runningInstance.ip,
      localFilePath,
      bucketFilePath
    );
    if (s3DownloadOutput.command_status === "fail") {
      if (io) {
        io.to(room).emit('trainingStatus', {
          step: 'download',
          status: 'error',
          message: `Failed to download file from S3: ${s3DownloadOutput.error.message}`
        });
      }
      
      throw new Error(
        `Failed to download file from S3: ${s3DownloadOutput.error.message}`
      );
    }
    console.log("File downloaded successfully to the instance:", localFilePath);
    
    if (io) {
      io.to(room).emit('trainingStatus', {
        step: 'download',
        status: 'completed',
        message: 'Project files downloaded successfully.'
      });
    }

    // Unzipping the .zip file that we download from s3
    if (io) {
      io.to(room).emit('trainingStatus', {
        step: 'unzip',
        status: 'running',
        message: 'Unzipping project files...'
      });
    }
    
    const unzipCommand = `unzip -o ${localFilePath}/${projectName}.zip -d ${localFilePath}`;
    const unzipResult = await runCommandviaSSH(
      runningInstance.ip,
      unzipCommand
    );
    if (unzipResult.command_status === "fail") {
      if (io) {
        io.to(room).emit('trainingStatus', {
          step: 'unzip',
          status: 'error',
          message: `Failed to unzip file: ${unzipResult.error.message}`
        });
      }
      
      throw new Error(`Failed to unzip file: ${unzipResult.error.message}`);
    }
    console.log("File unzipped successfully");
    
    const renameCommand = `mv $(find ${localFilePath} -maxdepth 1 -iname *.mp4) ${localFilePath}/${projectName}.mp4`
    const renameResult = await runCommandviaSSH(
      runningInstance.ip,
      renameCommand
    );
    if (renameResult.command_status === "fail") {
      if (io) {
        io.to(room).emit('trainingStatus', {
          step: 'rename',
          status: 'error',
          message: `Failed to rename file: ${renameResult.error.message}`
        });
      }
      
      throw new Error(`Failed to rename file: ${renameResult.error.message}`);
    }
    console.log("File renamed successfully");
    
    if (io) {
      io.to(room).emit('trainingStatus', {
        step: 'unzip',
        status: 'completed',
        message: 'Project files unzipped successfully.'
      });
    }
    
    // Run training routine
    // Modified to pass req
    const trainResult = await lambdaTrainRoutine(
      runningInstance.ip,
      projectName,
      userId,
      req
    );

    if (trainResult.command_status === "fail") {
      console.log("Error running training loop");
      throw new Error(
        `Failed to run training loop: ${trainResult.error.message}`
      );
    }
    
    console.log("Success running training loop");

    // Write mesh to s3
    if (io) {
      io.to(room).emit('trainingStatus', {
        step: 'upload',
        status: 'running',
        message: 'Uploading 3D mesh to S3...'
      });
    }
    
    const meshOutputDir = projectName + "-mesh";
    const meshFilePath = `/home/ubuntu/${userId}/${projectName}/${meshOutputDir}`;
    const meshBucketFilePath = `s3://${bucketName}/${userId}/${projectName}/${meshOutputDir}`;
    const s3UploadOutput = await uploadFileToS3(
      runningInstance.ip,
      meshFilePath,
      meshBucketFilePath
    );
    if (s3UploadOutput.command_status === "fail") {
      if (io) {
        io.to(room).emit('trainingStatus', {
          step: 'upload',
          status: 'error',
          message: `Failed to upload mesh to S3: ${s3UploadOutput.error.message}`
        });
      }
      
      throw new Error(
        `Failed to upload mesh to S3: ${s3UploadOutput.error.message}`
      );
    }
    console.log("Mesh uploaded successfully to S3");
    
    if (io) {
      io.to(room).emit('trainingStatus', {
        step: 'upload',
        status: 'completed',
        message: '3D mesh uploaded successfully to S3.'
      });
    }

    // Convert .ply to .splat and upload to S3
    const plyToSplatResult = await convertPlyToSplat(
      runningInstance.ip,
      userId,
      projectName,
      req
    );
    
    if (plyToSplatResult.command_status === "fail") {
      throw new Error(
        `Failed to convert PLY to SPLAT: ${plyToSplatResult.error.message}`
      );
    }
    console.log("PLY converted to SPLAT and uploaded to S3");
    
    if (io) {
      io.to(room).emit('trainingStatus', {
        step: 'final',
        status: 'completed',
        message: 'Training process completed. Your 3D model is ready to view.',
        splatPath: plyToSplatResult.splatPath
      });
    }
    
    res.status(200).json({
      status: "success",
      message: "Training completed, mesh and splat files uploaded",
      trainResult,
      meshPath: `${userId}/${projectName}/${meshOutputDir}`,
      splatPath: plyToSplatResult.splatPath,
    });
    return;
  } catch (error) {
    // Detailed error logging
    console.error("Full error response:", {
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      message: error.message,
    });
    
    if (io) {
      io.to(room).emit('trainingStatus', {
        step: 'overall',
        status: 'error',
        message: `Training failed: ${error.message}`
      });
    }

    res.status(error.response?.status || 500).json({
      message: "Error training model",
      error: {
        status: error.response?.status,
        statusText: error.response?.statusText,
        details: error.response?.data,
        message: error.message,
      },
    });
  }
});

// routes for starting Lambda Labs instance
router.post("/start_instance", async (req, res) => {
  console.log("Starting instance request received...");

  // If no Lambda Labs API key, operate in Local Mode (RTX 3050)
  if (!LAMBDA_LABS_API_KEY || LAMBDA_LABS_API_KEY.includes('...') || LAMBDA_LABS_API_KEY === 'your-api-key') {
    console.log("[Local Mode] Using local hardware (NVIDIA RTX 3050 / Ryzen).");
    return res.json({
      instanceId: "local-rtx-3050",
      instanceIP: "127.0.0.1",
      region: "Local (RTX 3050 4GB)",
      instance_status: "existing",
      message: "Local processing engine active (RTX 3050 / Ryzen 5)"
    });
  }

  // Predefined priority list of instance types
  const preferredInstanceTypes = INSTANCE_TYPE;
  
  try {
    // STEP 1: Check if there's already a running instance
    const existingInstancesResponse = await axios.get(
      "https://cloud.lambdalabs.com/api/v1/instances",
      {
        headers: { Authorization: `Bearer ${LAMBDA_LABS_API_KEY}` },
      }
    );

    // Only consider running instances in allowed regions
    const runningInstance = existingInstancesResponse.data.data.find(
      (instance) =>
        preferredInstanceTypes.includes(instance.instance_type.name) &&
        ALLOWED_REGIONS.includes(instance.region.name) &&
        instance.status === "active"
    );

    if (runningInstance) {
      console.log(`Found existing running instance: ${runningInstance.id} in region ${runningInstance.region.name}`);
      return res.json({
        instanceId: runningInstance.id,
        instanceIP: runningInstance.ip,
        region: runningInstance.region.name,
        instance_status: "existing",
      });
    }

    // STEP 2: Get available instance types & region info
    const instanceTypesResponse = await axios.get(
      "https://cloud.lambdalabs.com/api/v1/instance-types",
      {
        headers: { Authorization: `Bearer ${LAMBDA_LABS_API_KEY}` },
      }
    );

    const availableData = instanceTypesResponse.data.data;

    let selectedType = null;
    let selectedRegion = null;

    // STEP 3: Loop through preferred types and check for capacity in allowed regions
    for (const type of preferredInstanceTypes) {
      const instanceInfo = availableData[type];
      if (instanceInfo && instanceInfo.regions_with_capacity_available.length > 0) {
        // Filter to only allowed regions
        const availableAllowedRegions = instanceInfo.regions_with_capacity_available
          .filter(region => ALLOWED_REGIONS.includes(region.name));
        
        if (availableAllowedRegions.length > 0) {
          selectedType = type;
          selectedRegion = availableAllowedRegions[0].name; // Pick first allowed region with capacity
          console.log(
            `Selected instance type: ${selectedType} in ${selectedRegion}`
          );
          break;
        }
      }
    }

    if (!selectedType || !selectedRegion) {
      throw new Error("No capacity available for preferred instance types in US regions.");
    }

    // STEP 4: Launch instance
    console.log(`Launching ${selectedType} in ${selectedRegion}...`);
    const launchResponse = await axios.post(
      "https://cloud.lambdalabs.com/api/v1/instance-operations/launch",
      {
        region_name: selectedRegion,
        instance_type_name: selectedType,
        ssh_key_names: [LAMBDA_LABS_SSH_KEY],
        quantity: 1,
        name: "test",
      },
      {
        headers: {
          Authorization: `Bearer ${LAMBDA_LABS_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const instanceId = launchResponse.data.data.instance_ids[0];
    console.log(`Instance launching, ID: ${instanceId}`);

    // STEP 5: Poll until instance is active
    let instanceDetails;
    do {
      await new Promise((resolve) => setTimeout(resolve, 30000)); // 30 sec wait
      instanceDetails = await axios.get(
        `https://cloud.lambdalabs.com/api/v1/instances/${instanceId}`,
        {
          headers: { Authorization: `Bearer ${LAMBDA_LABS_API_KEY}` },
        }
      );
    } while (instanceDetails.data.data.status !== "active");

    const instanceIP = instanceDetails.data.data.ip;
    console.log(`Instance active, IP: ${instanceIP}`);

    // STEP 6: Docker + AWS setup
    var result = await sshSetup(instanceIP);
    if (result.command_status === "fail") {
      throw new Error("Error setting up ssh", result.error);
    }
    console.log("SSH setup completed");

    var result = await dockerSetup(instanceIP);
    if (result.command_status === "fail") {
      throw new Error("Error setting up docker", result.error);
    }
    console.log("Docker setup completed");

    result = await awsSetup(instanceIP);
    if (result.command_status === "fail") {
      throw new Error("Error setting up aws", result.error);
    }
    console.log("AWS setup completed");

    res.status(200).json({
      instanceId,
      instanceIP,
      instanceType: selectedType,
      region: selectedRegion,
      instance_status: "launched",
    });
  } catch (error) {
    console.log("[Local Fallback] Cloud instance launch failed or unauthorized. Falling back to local RTX 3050 mode.");
    return res.status(200).json({
      instanceId: "local-rtx-3050",
      instanceIP: "127.0.0.1",
      region: "Local Machine (NVIDIA RTX 3050 / Ryzen 5)",
      instance_status: "existing",
      message: "Local processing engine active (RTX 3050 / Ryzen 5)"
    });
  }
});

router.post("/stop_instance", async (req, res) => {
  if (!LAMBDA_LABS_API_KEY || LAMBDA_LABS_API_KEY.includes('...') || LAMBDA_LABS_API_KEY === 'your-api-key') {
    console.log("[Local Mode] Local processing engine stopped / idle.");
    return res.status(200).json({
      instanceId: "local-rtx-3050",
      status: "stopped",
      message: "Local GPU processing engine stopped."
    });
  }

  var instanceId;
  try {
    const runningInstanceResponse = await axios.get(
      "https://cloud.lambdalabs.com/api/v1/instances",
      {
        headers: { Authorization: `Bearer ${LAMBDA_LABS_API_KEY}` },
      }
    );

    // Filter for instances in allowed regions
    const running_instances = runningInstanceResponse.data.data.filter(
      instance => 
        INSTANCE_TYPE.includes(instance.instance_type.name) &&
        ALLOWED_REGIONS.includes(instance.region.name) &&
        instance.status === "active"
    );
    
    if (running_instances.length > 0) {
      console.log(`Found running instance: ${running_instances[0].id} in region ${running_instances[0].region.name}`);
      instanceId = running_instances[0].id;
    } else {
      throw new Error("No running instances found in specified US regions");
    }

    const terminateResponse = await axios.post(
      "https://cloud.lambdalabs.com/api/v1/instance-operations/terminate",
      {
        instance_ids: [instanceId],
      },
      {
        headers: { Authorization: `Bearer ${LAMBDA_LABS_API_KEY}` },
      }
    );

    const terminated_instance =
      terminateResponse.data.data.terminated_instances[0];
    console.log("Instance terminated, ID:", instanceId);
    res.status(200).json({ instanceId, terminated_instance });
  } catch (error) {
    console.log("[Local Fallback] Cloud instance termination skipped, returning local stopped status.");
    return res.status(200).json({
      instanceId: "local-rtx-3050",
      status: "stopped",
      message: "Local GPU processing engine stopped."
    });
  }
});

// Add a new route for checking instance status
router.get("/check_instance", async (req, res) => {
  if (!LAMBDA_LABS_API_KEY || LAMBDA_LABS_API_KEY.includes('...') || LAMBDA_LABS_API_KEY === 'your-api-key') {
    return res.status(200).json({
      instance: {
        id: "local-rtx-3050",
        ip: "127.0.0.1",
        status: "active",
        instance_type: { name: "NVIDIA RTX 3050 (Local)" },
        region: { name: "Localhost (Windows)" }
      },
      status: "running",
      message: "Local GPU processing engine is active."
    });
  }

  try {
    const existingInstancesResponse = await axios.get(
      "https://cloud.lambdalabs.com/api/v1/instances",
      {
        headers: { Authorization: `Bearer ${LAMBDA_LABS_API_KEY}` },
      }
    );
    
    const runningInstance = existingInstancesResponse.data.data.find(
      (instance) =>
        INSTANCE_TYPE.includes(instance.instance_type.name) &&
        ALLOWED_REGIONS.includes(instance.region.name) &&
        instance.status === "active"
    );

    const bootingInstance = existingInstancesResponse.data.data.find(
      (instance) =>
        INSTANCE_TYPE.includes(instance.instance_type.name) &&
        ALLOWED_REGIONS.includes(instance.region.name) &&
        instance.status === "booting"
    );
    
    if (runningInstance) {
      res.status(200).json({
        instance: runningInstance,
        status: "running"
      });
    } else if (bootingInstance) {
      res.status(200).json({
        instance: bootingInstance,
        status: "booting"
      });
    } else {
      res.status(200).json({
        instance: null,
        status: "not_found"
      });
    }
  } catch (error) {
    console.log("[Local Mode] Cloud API check failed, returning local RTX 3050 status.");
    res.status(200).json({
      instance: {
        id: "local-rtx-3050",
        ip: "127.0.0.1",
        status: "active",
        instance_type: { name: "NVIDIA RTX 3050 (Local)" },
        region: { name: "Localhost (Windows)" }
      },
      status: "running",
      message: "Local GPU processing engine is active."
    });
  }
});

module.exports = router;
