const fs = require('fs');
const path = require('path');

function copyNativeModule(moduleName) {
  const sourcePath = path.join(__dirname, '..', 'node_modules', moduleName);
  const destinations = [
    path.join(__dirname, '..', 'out', 'node_modules', moduleName),
    path.join(__dirname, '..', 'out', '..', 'node_modules', moduleName)
  ];

  destinations.forEach(destPath => {
    if (path.resolve(sourcePath) !== path.resolve(destPath)) {
      if (!fs.existsSync(destPath)) {
        fs.mkdirSync(destPath, { recursive: true });
      }
      fs.cpSync(sourcePath, destPath, { recursive: true });
      console.log(`Copied ${sourcePath} to ${destPath}`);
    } else {
      console.log(`Skipped copying ${sourcePath} to itself`);
    }
  });
}

copyNativeModule('udx-native');
copyNativeModule('sodium-native');