## Example Provider Configurations and Notes

These example configurations serve as a starting point. Individual adjustments may be required depending on your specific hardware and software environments.

### Testing Your Provider Configuration
Before diving into specific provider setups, it's important to know that Twinny now offers a way to test your provider configurations. When adding or editing a provider in the Twinny settings (accessible via the activity bar icon, then navigating to the "Providers" tab), you'll find a "Test Provider" button. Clicking this will attempt to make a basic API call to your provider using the entered details. This can help you quickly verify if the hostname, port, API path, and API key (if applicable) are correctly configured and if the provider is reachable from your system.

For users utilizing Ollama, there's an additional convenience: a dedicated "Test Ollama Connection" button is available in the main settings page (accessible via the activity bar icon, then navigating to "Templates & Onboarding"). This allows for a quick check of your local Ollama server's availability.

### Ollama Configuration

#### FIM (Auto-complete)

- **Hostname:** `localhost`
- **Port:** `11434`
- **Path:** `/api/generate`
- **Model Name:** `codellama:7b-code`
- **FIM Template:** Select the appropriate template based on the model. For instance, `codellama:7b-code` uses the Codellama template, while `deepseek-coder:6.7b-base-q5_K_M` uses the Deepseek template.

#### Chat Configuration

- **Hostname:** `localhost`
- **Port:** `11434`
- **Path:** `/v1/chat/completions`
- **Model Name:** `codellama:7b-instruct` or any effective instruct model

### Open WebUI

Open WebUI can be used a proxy API for twinny, simply configure the endpoint to match what is served by OpenWeb UI.

#### FIM (Auto-complete)

- **Hostname:** `localhost`
- **Port:** Check documentation
- **Path:** Check documentation
- **Model Name:** `codellama:7b-code`
- **FIM Template:** Use the template corresponding to your model, similar to the desktop configuration.

#### Chat Configuration

- **Hostname:** `localhost`
- **Port:** Check documentation
- **Path:** Check documentation
- **Model Name:** `codellama:7b-instruct` or another reliable instruct model

### LM Studio

#### FIM (Auto-complete)

- **Hostname:** `localhost`
- **Port:** `1234`
- **Path:** `/v1/completions`
- **Model Name:** Base model such as `codellama:7b`
- **Preset:** CodeLlama Completion
- **FIM Template:** Choose a template that matches your model's specifications.

#### Chat Configuration

- **Hostname:** `localhost`
- **Port:** `1234`
- **Path:** `/v1/chat/completions`
- **Model Name:** `codellama:7b-instruct` or your preferred instruct model
- **Preset:** Default or `CodeLlama Instruct`

### LiteLLM

#### FIM (Auto-complete)

LiteLLM can technically support auto-complete, but it's optimized as a proxy for external APIs like OpenAI and Anthropic.

#### Chat Configuration

- **Hostname:** `localhost`
- **Port:** `4000`
- **Path:** `/v1/chat/completions`

Start LiteLLM with the following command:

```bash
litellm --model gpt-4-turbo
```

### Llama.cpp

#### FIM (Auto-complete)

Start Llama.cpp in the terminal with this Docker command:

```bash
docker run -p 8080:8080 --gpus all --network bridge -v /home/<user>/.cache/lm-studio/models/TheBloke/CodeLlama-7B-GGUF/:/models local/llama.cpp:full-cuda --server -m /models/codellama-7b.Q5_K_M.gguf -c 2048 -ngl 43 -mg 1 --port 8080 --host 0.0.0.0
```

Configure your provider settings as follows:

- **Hostname:** `localhost`
- **Port:** `8080`
- **Path:** `/completion`
- **FIM Template:** Choose the appropriate template based on the model, such as `CodeLlama-7B-GGUF`.

#### Chat Configuration

The performance of chat functionalities with Llama.cpp has been mixed. If you obtain favorable results, please share them by opening an issue or a pull request.

- **Hostname:** `localhost`
- **Port:** `8080`
- **Path:** `/completion`
- **Model Name:** `CodeLlama-7B-GGUF` or any other strong instruct model


### Oobabooga

```bash
bash start_linux.sh --api --listen
```

#### FIM (Auto-complete)

Navigate to `http://0.0.0.0:7860/` to load your model:

- **Hostname:** `localhost`
- **Port:** `5000`
- **Path:** `/v1/completions`
- **Model Name:** `CodeLlama-7B-GGUF` or another effective instruct model
- **FIM Template:** Select a template that matches the model, such as `CodeLlama-7B-GGUF` or `deepseek-coder:6.7b-base-q5_K_M`.

#### Chat Configuration

Chat functionality has not been successful on Linux with Oobabooga:

- **Hostname:** `localhost`
- **Port:** `5000`
- **Path:** `/v1/chat/completions`
- **Model Name:** `CodeLlama-7B-GGUF`
