/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable no-undef */
//@ts-check

'use strict'

const path = require('path')
const NodePolyfillPlugin = require('node-polyfill-webpack-plugin')

//@ts-check
/** @typedef {import('webpack').Configuration} WebpackConfig **/

/** @type WebpackConfig */
const extensionConfig = {
  target: 'node',
  mode: 'none',

  entry: './src/index.ts',
  output: {
    path: path.resolve(__dirname, 'out'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2'
  },
  externals: {
    vscode: 'commonjs vscode',
  },
  resolve: {
    extensions: ['.ts', '.tsx', '.js']
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
      }
    ]
  },
  devtool: 'nosources-source-map',
  infrastructureLogging: {
    level: 'log'
  }
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
    },
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
