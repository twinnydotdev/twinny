import * as path from 'path';
import * as fs from 'fs';

const Module = require('module');

type ResolveFilenameFunction = (request: string, parent: NodeModule, isMain: boolean, options?: { paths?: string[] }) => string;

const originalResolveFilename = Module._resolveFilename as ResolveFilenameFunction;

const nativeModules = ['udx-native', 'sodium-native'];

  (Module as any)._resolveFilename = function (
    this: typeof Module,
    request: string,
    parent: NodeModule,
    isMain: boolean,
    options?: { paths?: string[] }
  ): string {
    if (nativeModules.includes(request)) {
      const possiblePaths = [
        path.join(__dirname, '..', 'node_modules', request),
        path.join(__dirname, 'node_modules', request),
        path.join(__dirname, '..', '..', 'node_modules', request)
      ];

      for (const newPath of possiblePaths) {
        if (fs.existsSync(newPath)) {
          return originalResolveFilename.call(this, newPath, parent, isMain, options);
        }
      }
    }

    return originalResolveFilename.call(this, request, parent, isMain, options);
  };

export { };