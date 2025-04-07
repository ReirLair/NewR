import fs from 'fs-extra';
import unzipper from 'unzipper';
import path from 'path';

const zipFile = 'upload.zip'; // Replace with your zip file name
const targetDir = process.cwd(); // Root directory

async function unzipAndReplace() {
  if (!fs.existsSync(zipFile)) {
    console.error(`File not found: ${zipFile}`);
    return;
  }

  const directory = await unzipper.Open.file(zipFile);

  for (const file of directory.files) {
    const filePath = path.join(targetDir, file.path);

    if (file.type === 'Directory') {
      await fs.ensureDir(filePath);
    } else {
      await fs.ensureDir(path.dirname(filePath)); // Make sure parent dirs exist
      const readStream = file.stream();
      const writeStream = fs.createWriteStream(filePath);
      await new Promise((resolve, reject) => {
        readStream.pipe(writeStream).on('finish', resolve).on('error', reject);
      });
    }
  }

  await fs.unlink(zipFile); // Delete zip after extraction
  console.log(`Unzipped and replaced files from ${zipFile}`);
}

unzipAndReplace().catch(console.error);