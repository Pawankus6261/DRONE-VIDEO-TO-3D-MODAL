const express = require('express');
const AWS = require('aws-sdk');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const isS3Configured = Boolean(
    process.env.AWS_ACCESS_KEY_ID &&
    process.env.AWS_SECRET_ACCESS_KEY &&
    process.env.S3_BUCKET_NAME &&
    !process.env.AWS_ACCESS_KEY_ID.includes('...') &&
    process.env.AWS_ACCESS_KEY_ID !== 'your-aws-access-key-id'
);

let s3 = null;
if (isS3Configured) {
    s3 = new AWS.S3({
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        region: process.env.AWS_REGION || 'us-east-1'
    });
}

// Local storage directory fallback
const LOCAL_UPLOADS_DIR = path.join(__dirname, '../uploads');
if (!fs.existsSync(LOCAL_UPLOADS_DIR)) {
    fs.mkdirSync(LOCAL_UPLOADS_DIR, { recursive: true });
}

// Configure multer for file upload handling (memory storage)
const upload = multer({ storage: multer.memoryStorage() });

// Route to upload a file (S3 or local fallback)
router.post('/upload', upload.single('file'), async (req, res) => {
    const file = req.file;
    const { userId, projectName } = req.body;

    if (!file) {
        return res.status(400).json({ message: "No file provided" });
    }

    if (!userId || !projectName) {
        return res.status(400).json({ message: "Missing userId or projectName" });
    }

    if (isS3Configured && s3) {
        const params = {
            Bucket: process.env.S3_BUCKET_NAME,
            Key: `${userId}/${projectName}/${file.originalname}`,
            Body: file.buffer,
            ContentType: file.mimetype
        };

        try {
            const data = await s3.upload(params).promise();
            return res.status(200).json({ message: 'File uploaded successfully to S3', data });
        } catch (error) {
            console.error('Error uploading file to S3:', error);
            return res.status(500).json({ message: 'Error uploading file to S3', error: error.message });
        }
    }

    // Local Storage Fallback
    try {
        const targetDir = path.join(LOCAL_UPLOADS_DIR, userId, projectName);
        fs.mkdirSync(targetDir, { recursive: true });
        const filePath = path.join(targetDir, file.originalname);
        fs.writeFileSync(filePath, file.buffer);

        console.log(`[Local Upload] Saved file to ${filePath}`);
        return res.status(200).json({
            message: 'File uploaded successfully (Local storage mode)',
            data: {
                Location: `http://localhost:8000/uploads/${userId}/${projectName}/${file.originalname}`,
                Key: `${userId}/${projectName}/${file.originalname}`
            }
        });
    } catch (error) {
        console.error('Error saving local file:', error);
        return res.status(500).json({ message: 'Error saving local file', error: error.message });
    }
});

// Route to get all project names for a given user
router.get('/projects/:userId', async (req, res) => {
    const { userId } = req.params;

    if (!userId) {
        return res.status(400).json({ message: "Missing userId parameter" });
    }

    if (isS3Configured && s3) {
        const params = {
            Bucket: process.env.S3_BUCKET_NAME,
            Prefix: `${userId}/`,
            Delimiter: '/'
        };

        try {
            const data = await s3.listObjectsV2(params).promise();
            const projectNames = (data.CommonPrefixes || []).map(prefix =>
                prefix.Prefix.split('/')[1]
            ).filter(Boolean);

            return res.status(200).json({ projects: projectNames });
        } catch (error) {
            console.error('Error fetching S3 project names:', error);
            return res.status(500).json({ message: 'Error fetching project names from S3', error: error.message });
        }
    }

    // Local Storage Fallback
    try {
        const userDir = path.join(LOCAL_UPLOADS_DIR, userId);
        if (!fs.existsSync(userDir)) {
            return res.status(200).json({ projects: [] });
        }

        const projectNames = fs.readdirSync(userDir, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);

        return res.status(200).json({ projects: projectNames });
    } catch (error) {
        console.error('Error reading local projects:', error);
        return res.status(200).json({ projects: [] });
    }
});

// Route to delete a project and all its files
router.delete('/projects/:userId/:projectName', async (req, res) => {
    const { userId, projectName } = req.params;

    if (!userId || !projectName) {
        return res.status(400).json({ message: "Missing userId or projectName" });
    }

    if (isS3Configured && s3) {
        const params = {
            Bucket: process.env.S3_BUCKET_NAME,
            Prefix: `${userId}/${projectName}/`
        };

        try {
            const listedObjects = await s3.listObjectsV2(params).promise();

            if (!listedObjects.Contents || listedObjects.Contents.length === 0) {
                return res.status(404).json({ message: "Project not found or already empty." });
            }

            const deleteParams = {
                Bucket: process.env.S3_BUCKET_NAME,
                Delete: {
                    Objects: listedObjects.Contents.map(({ Key }) => ({ Key }))
                }
            };

            await s3.deleteObjects(deleteParams).promise();
            return res.status(200).json({ message: `Project "${projectName}" deleted successfully.` });
        } catch (error) {
            console.error('Error deleting project from S3:', error);
            return res.status(500).json({ message: 'Error deleting project', error: error.message });
        }
    }

    // Local Storage Fallback
    try {
        const projectDir = path.join(LOCAL_UPLOADS_DIR, userId, projectName);
        if (fs.existsSync(projectDir)) {
            fs.rmSync(projectDir, { recursive: true, force: true });
            return res.status(200).json({ message: `Project "${projectName}" deleted successfully.` });
        }
        return res.status(200).json({ message: `Project "${projectName}" already removed.` });
    } catch (error) {
        console.error('Error deleting local project:', error);
        return res.status(500).json({ message: 'Error deleting project', error: error.message });
    }
});

// Route to get all files in a specific project folder
router.get('/projects/:userId/:projectName/files', async (req, res) => {
    const { userId, projectName } = req.params;

    if (!userId || !projectName) {
        return res.status(400).json({ message: "Missing userId or projectName" });
    }

    if (isS3Configured && s3) {
        const params = {
            Bucket: process.env.S3_BUCKET_NAME,
            Prefix: `${userId}/${projectName}/`
        };

        try {
            const data = await s3.listObjectsV2(params).promise();

            if (!data.Contents || data.Contents.length === 0) {
                return res.status(200).json({ files: [] });
            }

            const files = await Promise.all(
                data.Contents.map(async (file) => {
                    const signedUrl = await s3.getSignedUrlPromise('getObject', {
                        Bucket: process.env.S3_BUCKET_NAME,
                        Key: file.Key,
                        Expires: 60 * 5
                    });

                    return {
                        key: file.Key,
                        fileName: file.Key.split('/').pop(),
                        size: file.Size,
                        lastModified: file.LastModified,
                        url: signedUrl
                    };
                })
            );

            return res.status(200).json({ files });
        } catch (error) {
            console.error('Error fetching files from S3:', error);
            return res.status(500).json({ message: 'Error fetching files', error: error.message });
        }
    }

    // Local Storage Fallback
    try {
        const projectDir = path.join(LOCAL_UPLOADS_DIR, userId, projectName);
        if (!fs.existsSync(projectDir)) {
            return res.status(200).json({ files: [] });
        }

        const entries = fs.readdirSync(projectDir);
        const files = entries.map((entry) => {
            const fullPath = path.join(projectDir, entry);
            const stat = fs.statSync(fullPath);
            return {
                key: `${userId}/${projectName}/${entry}`,
                fileName: entry,
                size: stat.size,
                lastModified: stat.mtime,
                url: `http://localhost:8000/uploads/${userId}/${projectName}/${entry}`
            };
        });

        return res.status(200).json({ files });
    } catch (error) {
        console.error('Error reading local files:', error);
        return res.status(200).json({ files: [] });
    }
});

// Route to get depth analysis report and depth maps for a project
router.get('/projects/:userId/:projectName/depth-analysis', async (req, res) => {
    const { userId, projectName } = req.params;
    const projectDir = path.join(LOCAL_UPLOADS_DIR, userId, projectName);
    const workspaceMetrics = path.join(__dirname, '..', '..', 'workspace', projectName, 'metrics', 'depth_analysis.json');
    const uploadMetrics = path.join(projectDir, 'depth_analysis.json');

    let metricsFile = null;
    if (fs.existsSync(uploadMetrics)) {
        metricsFile = uploadMetrics;
    } else if (fs.existsSync(workspaceMetrics)) {
        metricsFile = workspaceMetrics;
    }

    if (!metricsFile) {
        return res.status(404).json({ message: "Depth analysis not yet generated for this project." });
    }

    try {
        const data = JSON.parse(fs.readFileSync(metricsFile, 'utf8'));
        const baseUrl = `http://localhost:8000/uploads/${userId}/${projectName}`;

        // Augment per-frame analysis with full URLs
        if (data.per_frame_analysis && Array.isArray(data.per_frame_analysis)) {
            data.per_frame_analysis = data.per_frame_analysis.map(frame => ({
                ...frame,
                keyframe_url: `${baseUrl}/${frame.filename}`,
                depth_url: `${baseUrl}/${frame.depth_image}`,
                confidence_url: `${baseUrl}/${frame.confidence_image}`,
                segmentation_url: frame.segmentation_image ? `${baseUrl}/${frame.segmentation_image}` : `${baseUrl}/${frame.filename.replace('.png', '_seg.png')}`
            }));
        }

        const summaryImgPath = path.join(projectDir, 'depth_analysis_summary.png');
        if (fs.existsSync(summaryImgPath)) {
            data.summary_image_url = `${baseUrl}/depth_analysis_summary.png`;
        }

        return res.status(200).json(data);
    } catch (err) {
        console.error("Error reading depth analysis:", err);
        return res.status(500).json({ message: "Error reading depth analysis", error: err.message });
    }
});

module.exports = router;