/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable no-undef */
//@ts-check

'use strict'

const path = require('path')
const NodePolyfillPlugin = require('node-polyfill-webpack-plugin')
const CopyPlugin = require('copy-webpack-plugin')
const WasmPackPlugin = require('@wasm-tool/wasm-pack-plugin')

//@ts-check
/** @typedef {import('webpack').Configuration} WebpackConfig **/

/** @type WebpackConfig */
const extensionConfig = {
  target: 'node',
  mode: 'none',
  entry: './src/index.ts',
  output: {
    path: path.resolve(__dirname, 'out'),
    filename: 'index.js',
    libraryTarget: 'commonjs2'
  },
  externals: {
    vscode: 'commonjs vscode',
    vectordb: 'commonjs2 vectordb'
  },
  resolve: {
    extensions: ['.ts', '.tsx', '.js']
  },
  experiments: {
    asyncWebAssembly: true,
    syncWebAssembly: true
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader'
          }
        ]
      },
      {
        test: /\.hbs$/,
        exclude: /(node_modules)/,
        loader: 'handlebars-loader'
      },
      {
        test: /\.wasm$/,
        type: 'asset/resource',
        generator: {
          filename: 'static/chunks/[path][name].[hash][ext]'
        }
      }
    ]
  },
  devtool: 'nosources-source-map',
  infrastructureLogging: {
    level: 'log'
  },
  plugins: [
    new WasmPackPlugin({
      crateDirectory: __dirname
    }),
    new CopyPlugin({
      patterns: [
        {
          from: 'node_modules/onnxruntime-web/dist/ort-wasm-simd.wasm',
          to: '.'
        },
        {
          from: 'node_modules/tree-sitter-wasms/out',
          to: './tree-sitter-wasms'
        },
        {
          from: 'models',
          to: './models'
        },
        {
          from: 'node_modules/web-tree-sitter/tree-sitter.wasm',
          to: './tree-sitter.wasm'
        },
        {
          from: 'pkg',
          to: './pkg'
        }
      ]
    })
  ]
}

/** @type WebpackConfig */
const webviewConfig = {
  target: 'web',
  mode: 'development',

  entry: './src/webview/index.tsx',
  output: {
    path: path.resolve(__dirname, 'out'),
    filename: 'sidebar.js'
  },
  resolve: {
    extensions: ['.js', '.ts', '.tsx', '.json'],
    fallback: {
      http: require.resolve('stream-http')
    }
  },
  experiments: {
    asyncWebAssembly: true,
    syncWebAssembly: true,
  },
  plugins: [new NodePolyfillPlugin()],
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        exclude: /node_modules/,
        use: {
          loader: 'ts-loader'
        }
      },
      {
        test: /\.wasm$/,
        type: 'asset/resource',
        generator: {
          filename: 'static/chunks/[path][name].[hash][ext]'
        }
      },
      {
        test: /\.(module\.css)|(.css)$/,
        use: [
          'style-loader',
          {
            loader: 'css-loader',
            options: { modules: true }
          }
        ]
      }
    ]
  },
  devtool: 'source-map'
}

module.exports = [extensionConfig, webviewConfig]
