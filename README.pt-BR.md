# twinny

O assistente de programação com IA para o Visual Studio Code que fica dentro da sua rede. Autocompletar, edição inline, chat, revisão de código e mais, com o servidor de modelos que você escolher: na sua máquina, em outro dispositivo seu, em uma API hospedada, ou em um gateway compartilhado por toda a equipe. Gratuito, código aberto, licença MIT, sem telemetria, sem login.

[Instalar pelo Marketplace](https://marketplace.visualstudio.com/items?itemName=rjmacarthy.twinny) · [Documentação](https://docs.twinny.dev/) · [Novidades](https://docs.twinny.dev/reference/whats-new/) · [Changelog](CHANGELOG.md) · [Equipes](https://docs.twinny.dev/teams/overview/) · [English](README.md) · [中文](README.zh-CN.md)

A documentação está em inglês e chinês; os links abaixo levam à versão em inglês.

## Primeiros passos

1. Instale o twinny pelo Marketplace (VS Code 1.93 ou mais recente).
2. Rode um servidor de modelos. Ollama, LM Studio e llama.cpp são encontrados nas portas habituais na primeira inicialização; o twinny pergunta quais modelos usar.
3. Digite. As sugestões aparecem como texto fantasma; a barra lateral tem o chat.

O [guia rápido](https://docs.twinny.dev/getting-started/quick-start/) explica como escolher servidor e modelos para o seu hardware, e a [solução de problemas](https://docs.twinny.dev/getting-started/troubleshooting/) explica cada mensagem de erro.

## O que ele faz

- **[Autocompletar código](https://docs.twinny.dev/features/code-completion/).** Sugestões de preenchimento no meio do código enquanto você digita, transmitidas como texto fantasma e encerradas em um ponto sensato. O contexto vem dos arquivos abertos, dos imports, do servidor de linguagem e das suas edições recentes. Ajustado para funcionar bem com um modelo de 7B.
- **[Edição inline](https://docs.twinny.dev/features/inline-edit/).** Ctrl+I, descreva a mudança e revise como um diff no editor. Aceite ou rejeite por trecho. *Corrigir com o twinny* em qualquer diagnóstico.
- **[Chat](https://docs.twinny.dev/features/chat/)** sobre o seu código. Digite `@` para anexar arquivos, símbolos, o painel de problemas, o diff do git, o terminal ou uma busca no índice do workspace. As conversas são preservadas.
- **[Índice do workspace](https://docs.twinny.dev/features/workspace-index/).** Busca híbrida por palavras-chave e vetores no workspace, reordenada antes de chegar ao prompt e atualizada ao salvar. As fontes aparecem sob as respostas.
- **[Revisão de código](https://docs.twinny.dev/features/code-review/)** da árvore de trabalho, de um branch em relação à sua base ou de um pull request do GitHub, e **[mensagens de commit](https://docs.twinny.dev/features/commit-messages/)** a partir do diff preparado.
- **[Terminal](https://docs.twinny.dev/features/terminal/).** Escreva um comando a partir de uma descrição, mostrado antes de rodar. Quando um falha, o twinny encontra o arquivo e a linha e oferece a correção.
- **[Modelos de prompt](https://docs.twinny.dev/features/templates/)** editáveis, e cada recurso é um comando comum do VS Code que você pode reatribuir.

Tudo roda contra um servidor que você controla. Sem telemetria, sem conta. Veja [Barra de status, logs e privacidade](https://docs.twinny.dev/features/status-and-logs/).

## Servidores de modelos e provedores

| Onde o modelo roda | Como |
| --- | --- |
| **Na sua máquina** | [Ollama](https://docs.twinny.dev/providers/ollama/), [LM Studio](https://docs.twinny.dev/providers/lm-studio/), [llama.cpp](https://docs.twinny.dev/providers/llama-cpp/), QVAC, Oobabooga, LiteLLM, Open WebUI ou [qualquer servidor compatível com a OpenAI](https://docs.twinny.dev/providers/other-local-servers/). |
| **Em outro computador seu** | [Dispositivos](https://docs.twinny.dev/providers/devices/): pareie com um código e use a GPU daquela máquina por um link ponto a ponto criptografado. Sem conta, sem relay. |
| **Em uma API hospedada** | [OpenAI, Anthropic, Mistral (Codestral para autocompletar), DeepSeek, OpenRouter, Gemini, Groq, Cohere, Perplexity](https://docs.twinny.dev/providers/hosted-apis/). |
| **No gateway da sua equipe** | Conecte-se a um `twinny-server` e use os modelos que a equipe configurou. Veja abaixo. |

Misture: um modelo local para autocompletar, um hospedado para o chat. A página de [modelos compatíveis](https://docs.twinny.dev/providers/supported-models/) diz quais modelos servem para qual tarefa em qual hardware.

## Equipes: um gateway para todos

O `twinny-server` é um servidor pequeno e sem dependências que roda na máquina com os modelos e serve chat, autocompletar e embeddings ao VS Code de cada desenvolvedor. Os prompts vão para o seu gateway e o seu backend, e para mais nenhum lugar.

```sh
npx twinny-server quickstart
```

Isso encontra o seu servidor de modelos, escreve uma configuração, cria uma chave de administrador e começa a servir. Na página de administração você define os modelos padrão da equipe, envia a cada desenvolvedor um link de convite que abre o VS Code e o conecta, e vê o uso por pessoa e por modelo.

- **Uma chave por desenvolvedor**, guardada como hash, revogada na hora. Uso, falhas e tokens por pessoa e por modelo; nunca o conteúdo.
- **Reúna os computadores da própria equipe.** Um desenvolvedor ativa *Compartilhar este computador* e o servidor local dele passa a atender a equipe pelo gateway. Nenhuma porta a abrir.
- **Plugins** (licença): pull requests e issues do GitHub, GitLab, Gitea e Bitbucket listados na página de administração e revisados pelos seus próprios modelos, com a revisão publicada de volta no host; notificações no Slack, Discord e Teams; login SSO com qualquer provedor OpenID Connect; um índice de contexto compartilhado para o chat de todos os desenvolvedores; backups noturnos.
- **Política da equipe** (licença): só o gateway da equipe como provedor, modelos padrão travados, regras de roteamento que mantêm um workspace em backends locais, um prompt de sistema da equipe. Mostrada para consentimento antes de conectar.
- **Gravação** (licença): mantenha prompts e respostas no gateway, com aviso a cada desenvolvedor, exportados como dados de treinamento.
- **Operação**: um log de auditoria encadeado por hash de cada mudança administrativa, chaves de administrador somente leitura, métricas para o Prometheus, custos por desenvolvedor quando um modelo tem preço, uma fila de requisições para uma GPU compartilhada, Docker e um chart Helm.

Gratuito para cinco desenvolvedores, para sempre. Uma licença comprada com cartão adiciona assentos e ativa política, gravação e plugins; é verificada localmente e o gateway nunca liga para casa. Veja o [guia de equipes](https://docs.twinny.dev/teams/overview/), [licenciamento e assentos](https://docs.twinny.dev/teams/licensing/) e a referência do operador em [docs/gateway.md](docs/gateway.md).

## Estrutura do repositório

| Caminho | O que é |
| --- | --- |
| `src/extension` | A extensão do VS Code, por recurso: autocompletar, chat, edição inline, revisão, terminal, embeddings, provedores, conexão com a equipe. |
| `src/webview` | A barra lateral (React). |
| `src/protocol` | O protocolo entre a extensão e um gateway, e o protocolo WebSocket entre pares para computadores compartilhados. |
| `src/gateway` | O gateway: rotas, chaves, uso, licenciamento, página de administração, plugins. Compilado em `packages/twinny-server/cli.js`. |
| `src/licensing` | Verificação do token de licença (o lado que assina é privado). |
| `packages/twinny-server` | O pacote npm e os arquivos Docker do gateway. |
| `deploy/helm` | Chart Helm para Kubernetes. |
| `docs` | A referência do operador para o gateway e notas de design. |

## Contribuição

Issues e pull requests são bem-vindos no [GitHub](https://github.com/twinnydotdev/twinny). Descreva uma mudança maior em uma issue primeiro. O [CONTRIBUTING.md](CONTRIBUTING.md) tem os passos de build e teste; a suíte roda sem interface com `xvfb-run -a npm test`. Perguntas vão para as [discussões](https://github.com/twinnydotdev/twinny/discussions) ou para [@twinnydotdev](https://x.com/twinnydotdev).

## Apoie o twinny

O twinny é gratuito e de código aberto. Se ele se paga, uma licença de equipe é a melhor forma de apoiar. Doações também são bem-vindas. Bitcoin: `1PVavNkMmBmUz8nRYdnVXiTgXrAyaxfehj`

## Licença

MIT. O twinny está em desenvolvimento ativo e é fornecido como está.
