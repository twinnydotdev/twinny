#!/bin/bash

model_name=$1

export EVENTLET_NO_GREENDNS="yes"

if [ ! -d "../models/" ]; then
    mkdir ../models;
fi

if [ -z "$model_name" ]; then
    echo "Usage: bash model-onyx.sh <model> <output>"
    exit 1
fi

output_name=${model_name////_}; output_name=${output_name//\-/_};

echo "Converting $model_name to onyx $output_name";

optimum-cli export onnx --model "$model_name" "$output_name";
cp -r "$output_name" "../models/";
rm -rf "$output_name";
