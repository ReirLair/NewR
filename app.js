import fs from 'fs-extra';
import archiver from 'archiver';
import axios from 'axios';
import FormData from 'form-data';
import path from 'path';

// Set filenames
const outputZip = 'upload.zip';

// Create output stream and zip archive
const output = fs.createWriteStream(outputZip);
const archive = archiver('zip', { zlib: { level: 9 } });

output.on('close', async () => {
  console.log(`Zipped ${archive.pointer()} total bytes`);

  // Prepare FormData
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('fileToUpload', fs.createReadStream(outputZip));

  try {
    // Upload to Catbox
    const res = await axios.post('https://catbox.moe/user/api.php', form, {
      headers: form.getHeaders(),
    });
    console.log('Catbox URL:', res.data);
  } catch (err) {
    console.error('Upload failed:', err.response?.data || err.message);
  } finally {
    fs.unlinkSync(outputZip); // Optional: delete the zip after upload
  }
});

archive.on('error', (err) => {
  throw err;
});

archive.pipe(output);

// Append all files except node_modules
archive.glob('**/*', {
  ignore: ['node_modules/**', outputZip],
});

archive.finalize();