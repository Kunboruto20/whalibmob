<div align="center">

# whalibmob

**Uma biblioteca Node.js para WhatsApp capaz de registrar um número de telefone próprio.**

Todas as outras bibliotecas JavaScript se vinculam a uma conta que já existe no celular de alguém.
O whalibmob também faz isso — mas ele também consegue pegar um número de telefone puro, solicitar o
código por SMS ou chamada de voz, e trazer a conta à existência. Os dois transportes, uma única API.

[![npm](https://img.shields.io/npm/v/whalibmob?style=for-the-badge&color=25D366&label=npm)](https://www.npmjs.com/package/whalibmob)
[![node](https://img.shields.io/node/v/whalibmob?style=for-the-badge&color=339933&label=node)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/whalibmob?style=for-the-badge&color=555555)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/Kunboruto20/whalibmob/ci.yml?branch=main&style=for-the-badge&label=CI)](https://github.com/Kunboruto20/whalibmob/actions/workflows/ci.yml)
[![tipos](https://img.shields.io/badge/tipos-incluídos-3178C6?style=for-the-badge)](index.d.ts)

[![Read in English](https://img.shields.io/badge/%F0%9F%87%AC%F0%9F%87%A7_Read_in-English-555555?style=for-the-badge)](https://github.com/Kunboruto20/whalibmob/blob/main/README.md)

**Esta é a documentação em português do Brasil.** A versão original em inglês está em **[README.md](https://github.com/Kunboruto20/whalibmob/blob/main/README.md)**.

### Comece por aqui

[![Registrar um número](https://img.shields.io/badge/Registrar_um_número-SMS_ou_voz-25D366?style=for-the-badge)](#registrar-um-novo-número)
[![Vincular uma conta](https://img.shields.io/badge/Vincular_uma_conta-QR_ou_código_de_pareamento-128C7E?style=for-the-badge)](#vinculando-a-uma-conta-existente-código-de-pareamento-ou-qr)
[![Usar a CLI](https://img.shields.io/badge/Usar_a_CLI-sem_precisar_de_código-075E54?style=for-the-badge)](#cli--primeiros-passos)

[![API da Biblioteca](https://img.shields.io/badge/API_da_Biblioteca-Node.js-34B7F1?style=for-the-badge)](#api-da-biblioteca)
[![Enviar mensagens](https://img.shields.io/badge/Enviar_mensagens-texto_mídia_enquetes-34B7F1?style=for-the-badge)](#enviando-mensagens)
[![Tratar eventos](https://img.shields.io/badge/Tratar_eventos-recebidas_%26_recibos-34B7F1?style=for-the-badge)](#tratando-eventos)

</div>

##

> [!IMPORTANT]






Se você quer Novidades sobre o whalibmob, entre neste canal do whalibmob: https://t.me/+sHN4MDCyB7U5OWY0





> [!CAUTION]
> Use um número de telefone dedicado com esta biblioteca. Conectar-se com um número que já está ativo em um aparelho real fará com que o WhatsApp desconecte aquele aparelho.

> [!NOTE]
> **Em desenvolvimento ativo.** O WhatsApp mudou o protocolo mobile recentemente, e o whalibmob está sendo mantido em dia com ele a cada versão. Contribuições são bem-vindas — pull requests são aceitos.

> [!IMPORTANT]
> Este projeto não é afiliado, associado, autorizado, endossado nem oficialmente conectado de qualquer forma ao WhatsApp ou a qualquer uma de suas subsidiárias ou afiliadas. "WhatsApp" e nomes relacionados são marcas registradas de seus respectivos proprietários. Use por sua própria conta e risco.

- **Ele registra números.** Dê a ele um número de telefone que nunca esteve no WhatsApp, solicite o código por SMS, chamada de voz, flash call ou por uma conta antiga do WhatsApp, confirme, e a conta passa a existir — como um **dispositivo Android ou iOS**, na API Mobile. Sem celular, sem escanear nada, sem uma conta existente para pegar emprestada. Veja [Registrar um Novo Número](#registrar-um-novo-número).
- **Ele também fala WhatsApp Web**, por WebSocket. Quando um número não consegue receber um SMS, ou já está ativo em um celular, o whalibmob se vincula àquela conta por **QR code** ou por um **código de pareamento de 8 caracteres** e roda como um dos dispositivos vinculados dela — com todo o histórico de mensagens e a agenda de contatos da conta. Veja [Vinculando a uma Conta Existente](#vinculando-a-uma-conta-existente-código-de-pareamento-ou-qr).
- **A API é idêntica nos dois modos.** Tudo abaixo — envio, mídia, grupos, eventos — funciona da mesma forma, não importa como a sessão foi criada.
- Sem navegador, sem Selenium, sem runtime externo. Ele fala com o WhatsApp diretamente por um **socket TCP** com o handshake do **Protocolo Noise**.
- A criptografia do Protocolo Signal está **totalmente embutida** em JavaScript puro — sem binários nativos, sem node-gyp, roda em qualquer lugar onde o Node.js roda.

## Instalação

```sh
npm install whalibmob
```

Instale a CLI globalmente:

```sh
npm install -g whalibmob
```

## Índice

- [CLI — Primeiros Passos](#cli--primeiros-passos)
  - [Instalar a CLI](#instalar-a-cli)
  - [Configuração Inicial: Registrar um Número](#configuração-inicial-registrar-um-número)
  - [Conectar](#cli-conectar)
  - [Código de Pareamento](#cli-código-de-pareamento)
  - [Modo de Escuta](#modo-de-escuta)
- [CLI — Comandos do Shell Interativo](#cli--comandos-do-shell-interativo)
  - [Comandos de Mensagens](#comandos-de-mensagens)
    - [Enviar Texto](#enviar-texto)
    - [Enviar Imagem](#enviar-imagem)
    - [Enviar Vídeo](#enviar-vídeo)
    - [Enviar Áudio](#enviar-áudio)
    - [Enviar Mensagem de Voz](#enviar-mensagem-de-voz)
    - [Enviar Documento](#enviar-documento)
    - [Enviar Figurinha](#enviar-figurinha)
    - [Enviar Enquete](#enviar-enquete-cli)
    - [Reagir a uma Mensagem](#reagir-a-uma-mensagem)
    - [Editar uma Mensagem](#editar-uma-mensagem)
    - [Apagar uma Mensagem](#apagar-uma-mensagem)
    - [Publicar um Status / Story](#publicar-um-status--story)
    - [Encaminhar uma Mensagem](#encaminhar-uma-mensagem)
    - [Responder a uma Mensagem](#responder-a-uma-mensagem-cli)
    - [Enviar Localização](#enviar-localização-cli)
    - [Enviar Contato / vCard](#enviar-contato--vcard-cli)
  - [Comandos de Presença](#comandos-de-presença)
    - [Definir Online / Offline](#definir-online--offline)
    - [Indicadores de Digitando e Gravando](#indicadores-de-digitando-e-gravando)
    - [Assinar a Presença de um Contato](#assinar-a-presença-de-um-contato)
  - [Comandos de Perfil](#comandos-de-perfil)
    - [Alterar Nome de Exibição](#cli-alterar-nome-de-exibição)
    - [Alterar Texto do Recado](#cli-alterar-texto-do-recado)
    - [Alterar Foto de Perfil](#cli-alterar-foto-de-perfil)
    - [Alterar Configurações de Privacidade](#cli-alterar-configurações-de-privacidade)
  - [Comandos de Contatos](#comandos-de-contatos)
    - [Verificar Quem Tem WhatsApp](#verificar-quem-tem-whatsapp)
    - [Obter a URL da Foto de Perfil](#obter-a-url-da-foto-de-perfil)
    - [Obter o Recado de um Contato](#obter-o-recado-de-um-contato)
  - [Comandos de Gerenciamento de Conversas](#comandos-de-gerenciamento-de-conversas)
    - [Marcar como Lida / Não Lida](#marcar-como-lida--não-lida)
    - [Silenciar / Reativar Som](#silenciar--reativar-som)
    - [Fixar / Desafixar](#fixar--desafixar)
    - [Arquivar / Desarquivar](#arquivar--desarquivar)
    - [Favoritar / Desfavoritar uma Mensagem (CLI)](#favoritar--desfavoritar-uma-mensagem-cli)
    - [Sincronizar o App State (CLI)](#sincronizar-o-app-state)
    - [Contagem Regressiva de Restrição da Conta](#contagem-regressiva-de-restrição-da-conta)
    - [Mensagens Temporárias](#cli-mensagens-temporárias)
    - [Temporizador Padrão de Mensagens Temporárias](#temporizador-padrão-de-mensagens-temporárias)
    - [Bloquear / Desbloquear](#bloquear--desbloquear)
    - [Ver a Lista de Bloqueados](#ver-a-lista-de-bloqueados)
  - [Comandos de Grupos](#comandos-de-grupos)
    - [Criar um Grupo](#cli-criar-um-grupo)
    - [Sair de um Grupo](#cli-sair-de-um-grupo)
    - [Adicionar / Remover Participantes](#adicionar--remover-participantes)
    - [Promover / Rebaixar Administradores](#promover--rebaixar-administradores)
    - [Alterar o Nome do Grupo](#alterar-o-nome-do-grupo)
    - [Alterar a Descrição do Grupo](#alterar-a-descrição-do-grupo)
    - [Alterar a Foto do Grupo](#alterar-a-foto-do-grupo)
    - [Obter o Link de Convite](#obter-o-link-de-convite)
    - [Revogar o Link de Convite](#revogar-o-link-de-convite)
    - [Entrar em um Grupo pelo Código de Convite](#entrar-em-um-grupo-pelo-código-de-convite)
    - [Consultar Informações do Convite de Grupo](#consultar-informações-do-convite-de-grupo)
    - [Listar Todos os Grupos](#listar-todos-os-grupos)
    - [Consultar Metadados do Grupo](#consultar-metadados-do-grupo)
    - [Listar Participantes do Grupo](#listar-participantes-do-grupo)
    - [Solicitações de Entrada Pendentes](#solicitações-de-entrada-pendentes)
    - [Aprovar / Recusar Solicitações de Entrada](#aprovar--recusar-solicitações-de-entrada)
    - [Convites Pessoais (CLI)](#convites-pessoais)
    - [Configurações do Grupo](#configurações-do-grupo)
  - [Comandos de Comunidades](#comandos-de-comunidades-cli)
  - [Comandos de Newsletter / Canal](#comandos-de-newsletter--canal)
  - [Comando de Perfil Comercial](#comando-de-perfil-comercial-cli)
  - [Comandos de Registro (no shell)](#comandos-de-registro-no-shell)
  - [Comandos de Conexão (no shell)](#comandos-de-conexão-no-shell)
  - [Tabela Completa de Referência de Comandos](#tabela-completa-de-referência-de-comandos)
- [API da Biblioteca](#api-da-biblioteca)
  - [Conectando a Conta](#conectando-a-conta)
    - [Registrar um Novo Número](#registrar-um-novo-número)
    - [Registrando como Android](#registrando-como-android)
    - [Registrando uma conta WhatsApp Business](#registrando-uma-conta-whatsapp-business)
      - [Por que um APK está envolvido nisso](#por-que-um-apk-está-envolvido-nisso)
      - [Baixando o APK separadamente](#baixando-o-apk-separadamente)
      - [Lendo de um APK que você já tem](#lendo-de-um-apk-que-você-já-tem)
    - [Atestação de Dispositivo com Frida (opcional)](#atestação-de-dispositivo-com-frida-opcional)
    - [Conectar](#conectar)
      - [Opções do Cliente](#opções-do-cliente)
  - [Vinculando a uma Conta Existente (Código de Pareamento ou QR)](#vinculando-a-uma-conta-existente-código-de-pareamento-ou-qr)
    - [Solicitando um Código de Pareamento](#solicitando-um-código-de-pareamento)
    - [Vinculando por QR Code](#vinculando-por-qr-code)
    - [Depois do Vínculo — Igual nos Dois Caminhos](#depois-do-vínculo--igual-nos-dois-caminhos)
    - [Reconectando uma Sessão Vinculada](#reconectando-uma-sessão-vinculada)
    - [Escolhendo seu Próprio Código](#escolhendo-seu-próprio-código)
    - [Opções](#opções)
    - [Eventos Específicos do Vínculo](#eventos-específicos-do-vínculo)
    - [Obtendo o Histórico e a Agenda de Contatos](#obtendo-o-histórico-e-a-agenda-de-contatos)
    - [Arquivos de Sessão](#arquivos-de-sessão)
    - [Mídia no Modo Companion](#mídia-no-modo-companion)
    - [Identidade do Dispositivo](#identidade-do-dispositivo)
    - [Como o Código Protege o Vínculo](#como-o-código-protege-o-vínculo)
  - [Modo Companion — API Node.js](#modo-companion--api-nodejs)
    - [Exemplo Completo Funcional](#exemplo-completo-funcional)
    - [Métodos](#métodos)
    - [Eventos](#eventos)
    - [Lendo o que o Celular Enviou](#lendo-o-que-o-celular-enviou)
    - [Enviando](#enviando)
    - [Lidando com Reconexões](#lidando-com-reconexões)
    - [Sabendo em Qual Modo Você Está](#sabendo-em-qual-modo-você-está)
    - [Duas Sessões em um Único Número](#duas-sessões-em-um-único-número)
  - [O Número sob o Qual o WhatsApp Arquiva sua Conta](#o-número-sob-o-qual-o-whatsapp-arquiva-sua-conta)
  - [Quando o Registro É Recusado por Falta de Consentimento](#quando-o-registro-é-recusado-por-falta-de-consentimento)
  - [O Push Token](#o-push-token)
    - [Recebendo o Código por Push (sem digitá-lo)](#recebendo-o-código-por-push-sem-digitá-lo)
  - [Roteando o Tráfego por um Proxy](#roteando-o-tráfego-por-um-proxy)
    - [O que Passa por Ele](#o-que-passa-por-ele)
  - [Salvando e Restaurando Sessões](#salvando-e-restaurando-sessões)
    - [Mantendo a Versão Anunciada Atualizada](#mantendo-a-versão-anunciada-atualizada)
    - [Pré-chaves de Uso Único](#pré-chaves-de-uso-único)
    - [De Onde Vem a Pasta](#de-onde-vem-a-pasta)
    - [Descobrindo os Caminhos por Conta Própria](#descobrindo-os-caminhos-por-conta-própria)
  - [Utilitários do Signal Store](#utilitários-do-signal-store)
    - [makeCacheableSignalKeyStore](#makecacheablesignalkeystore)
    - [addTransactionCapability](#addtransactioncapability)
    - [assertMeId](#assertmeid)
    - [initAuthCreds](#initauthcreds)
    - [Padrão Recomendado de Empilhamento](#padrão-recomendado-de-empilhamento)
  - [Tratando Eventos](#tratando-eventos)
    - [Exemplo para Começar](#exemplo-para-começar)
    - [Todos os Eventos](#todos-os-eventos)
  - [Sincronização de Histórico](#sincronização-de-histórico)
    - [Como Funciona](#como-a-sincronização-de-histórico-funciona)
    - [Ouvindo os Eventos de Sincronização de Histórico](#ouvindo-os-eventos-de-sincronização-de-histórico)
    - [Arquivos Persistentes Gravados em Disco](#arquivos-persistentes-gravados-em-disco)
    - [Lendo o History Store](#lendo-o-history-store)
    - [tcToken — Defesa contra o Erro 463](#tctoken--defesa-contra-o-erro-463)
    - [Quando o 463 Significa que a Conta Está Restrita](#quando-o-463-significa-que-a-conta-está-restrita)
    - [O que É Automático e o que Você Precisa Fazer](#o-que-é-automático-e-o-que-você-precisa-fazer)
  - [Recebendo Mídia](#recebendo-mídia)
    - [Quando o Arquivo Sumiu do CDN](#quando-o-arquivo-sumiu-do-cdn)
  - [Enviando Mensagens](#enviando-mensagens)
    - [Mensagem de Texto](#mensagem-de-texto)
    - [Citar Mensagem](#citar-mensagem)
    - [Mencionar Usuário](#mencionar-usuário)
    - [Mensagem de Reação](#mensagem-de-reação)
    - [Editar Mensagem](#editar-mensagem)
    - [Apagar Mensagem](#apagar-mensagem)
    - [Encaminhar Mensagem](#encaminhar-mensagem)
    - [Enquete](#enquete)
    - [Resposta com Citação](#resposta-com-citação)
    - [Mensagem de Localização](#mensagem-de-localização)
    - [Mensagem de Contato (vCard)](#mensagem-de-contato-vcard)
    - [Link de Chamada](#link-de-chamada)
    - [Mensagens de Mídia](#mensagens-de-mídia)
      - [Mensagem de Imagem](#mensagem-de-imagem)
      - [Mensagem de Vídeo](#mensagem-de-vídeo)
      - [Mensagem de Áudio](#mensagem-de-áudio)
      - [Mensagem de Voz (PTT)](#mensagem-de-voz-ptt)
      - [Mensagem de Documento](#mensagem-de-documento)
      - [Mensagem de Figurinha](#mensagem-de-figurinha)
    - [Status / Stories](#status--stories)
    - [Privacidade do Status](#privacidade-do-status)
  - [Estados de Envio na Conversa](#estados-de-envio-na-conversa)
    - [Marcando Mensagens como Lidas](#marcando-mensagens-como-lidas)
    - [Marcar Mensagem de Voz como Reproduzida](#marcar-mensagem-de-voz-como-reproduzida)
    - [Atualizar Presença](#atualizar-presença)
  - [Modificando Conversas](#modificando-conversas)
    - [Arquivar / Desarquivar uma Conversa](#arquivar--desarquivar-uma-conversa)
    - [Silenciar / Reativar Som de uma Conversa](#silenciar--reativar-som-de-uma-conversa)
    - [Marcar uma Conversa como Lida / Não Lida](#marcar-uma-conversa-como-lida--não-lida)
    - [Fixar / Desafixar uma Conversa](#fixar--desafixar-uma-conversa)
    - [Favoritar / Desfavoritar uma Mensagem](#favoritar--desfavoritar-uma-mensagem)
    - [Lendo Alterações Feitas em Outro Lugar](#lendo-alterações-feitas-em-outro-lugar)
    - [Mensagens Temporárias](#mensagens-temporárias)
  - [Consultas de Usuário](#consultas-de-usuário)
    - [Verificar se um Número Tem WhatsApp](#verificar-se-um-número-tem-whatsapp)
    - [Buscar o Recado do Perfil](#buscar-o-recado-do-perfil)
    - [Buscar a Foto de Perfil](#buscar-a-foto-de-perfil)
    - [Assinar a Presença](#assinar-a-presença)
  - [Alterar o Perfil](#alterar-o-perfil)
    - [Alterar o Nome de Exibição](#alterar-o-nome-de-exibição)
    - [Alterar o Texto do Recado](#alterar-o-texto-do-recado)
    - [Alterar a Foto de Perfil](#alterar-a-foto-de-perfil)
  - [Privacidade](#privacidade)
    - [Bloquear / Desbloquear Usuário](#bloquear--desbloquear-usuário)
    - [Obter a Lista de Bloqueados](#obter-a-lista-de-bloqueados)
    - [Ler as Configurações de Privacidade](#ler-as-configurações-de-privacidade)
    - [Atualizar as Configurações de Privacidade](#atualizar-as-configurações-de-privacidade)
    - [Atualizar o Modo Temporário Padrão](#atualizar-o-modo-temporário-padrão)
  - [Comunidades](#comunidades)
    - [Criar uma Comunidade](#criar-uma-comunidade)
    - [Desativar / Excluir uma Comunidade](#desativar--excluir-uma-comunidade)
    - [Vincular Grupos a uma Comunidade](#vincular-grupos-a-uma-comunidade)
    - [Desvincular um Grupo de uma Comunidade](#desvincular-um-grupo-de-uma-comunidade)
  - [Newsletters (Canais)](#newsletters-canais)
    - [Criar uma Newsletter](#criar-uma-newsletter)
    - [Entrar / Sair de uma Newsletter](#entrar--sair-de-uma-newsletter)
    - [Consultar os Metadados da Newsletter](#consultar-os-metadados-da-newsletter)
    - [Atualizar a Descrição da Newsletter](#atualizar-a-descrição-da-newsletter)
    - [Publicar uma Atualização de Texto na sua Newsletter](#publicar-uma-atualização-de-texto-na-sua-newsletter)
  - [Perfil Comercial](#perfil-comercial)
  - [Grupos](#grupos)
    - [Criar um Grupo](#criar-um-grupo)
    - [Adicionar / Remover ou Rebaixar / Promover](#adicionar--remover-ou-rebaixar--promover)
    - [Alterar o Assunto](#alterar-o-assunto)
    - [Alterar a Descrição](#alterar-a-descrição)
    - [Alterar as Configurações](#alterar-as-configurações)
    - [Sair de um Grupo](#sair-de-um-grupo)
    - [Obter o Código de Convite](#obter-o-código-de-convite)
    - [Revogar o Código de Convite](#revogar-o-código-de-convite)
    - [Entrar Usando o Código de Convite](#entrar-usando-o-código-de-convite)
    - [Consultar Informações do Convite pelo Link](#consultar-informações-do-convite-pelo-link)
    - [Buscar Todos os Grupos](#buscar-todos-os-grupos)
    - [Consultar Metadados](#consultar-metadados)
    - [Obter a Lista de Solicitações de Entrada](#obter-a-lista-de-solicitações-de-entrada)
    - [Aprovar / Recusar Solicitação de Entrada](#aprovar--recusar-solicitação-de-entrada)
    - [Convites Pessoais](#convites-pessoais-1)
    - [Alternar Mensagens Temporárias no Grupo](#alternar-mensagens-temporárias-no-grupo)
- [IDs do WhatsApp](#ids-do-whatsapp)
- [Transporte](#transporte)
- [Criptografia de Mídia](#criptografia-de-mídia)
  - [Envio (Fluxo de Upload)](#envio-fluxo-de-upload)
  - [Recebimento (Fluxo de Download + Descriptografia)](#recebimento-fluxo-de-download--descriptografia)
- [Emulação de Dispositivo](#emulação-de-dispositivo)
  - [Início Rápido](#início-rápido-de-dispositivo)
  - [Perfis iOS](#perfis-ios)
  - [Perfis Android](#perfis-android)
  - [Campos Personalizados de Dispositivo](#campos-personalizados-de-dispositivo)
  - [Sobrescritas de Versão e Token](#sobrescritas-de-versão-e-token)
  - [Quando o servidor responde 405 na conexão](#quando-o-servidor-responde-405-na-conexão)
  - [Descobrindo a que o 405 se opõe](#descobrindo-a-que-o-405-se-opõe)
- [Licença](#licença)

---

## CLI — Primeiros Passos

### Instalar a CLI

Instale o whalibmob globalmente para ter o comando `wa` disponível em qualquer lugar do seu sistema:

```sh
npm install -g whalibmob
```

Verifique a instalação:

```sh
wa version
```

### Configuração Inicial: Registrar um Número

O registro é um processo feito uma única vez. Você precisa de um número de telefone que consiga receber um SMS ou uma chamada de voz. **Use um número dedicado** — não use um número que já esteja ativo em um aparelho WhatsApp real.

**Passo 1 — solicite um código de verificação**

```sh
# via SMS (default)
wa registration --request-code 919634847671

# via voice call
wa registration --request-code 919634847671 --method voice

# via an old WhatsApp account
wa registration --request-code 919634847671 --method wa_old

# via flash call — WhatsApp rings the number and hangs up (Android only)
WA_OS=android wa registration --request-code 919634847671 --method flash
```

A **flash call** não envia código nenhum para lugar algum. O WhatsApp liga para o número a partir de
um número descartável e derruba a chamada antes que ela possa ser atendida, e o código de
verificação *é* aquele número — os seus últimos 6 dígitos. O app oficial do Android
os lê do registro de chamadas; aqui, quem está com o celular na mão lê a chamada
perdida e digita os dígitos:

```sh
# phone shows a missed call from +40 21 555 123456
wa registration --register 919634847671 --code 123456
```

Colar o número inteiro também funciona — apenas os seis últimos dígitos são enviados. Não
atenda a chamada; ela se encerra sozinha, e atendê-la não verifica
nada.

Três coisas para saber antes de escolher esse método:

- **Somente Android.** O iOS não tem API para ler o número de uma chamada recebida, então
  o WhatsApp nunca oferece flash call lá. Pedir flash call como iOS é recusado antes que qualquer
  requisição saia, então o número não gasta nenhuma tentativa para descobrir isso.
- **O servidor decide.** A flash call não é oferecida para todo número ou país. Quando
  ela é recusada, a solicitação cai automaticamente para SMS e a sessão
  registra isso, para que o código SMS seja confirmado como um código SMS em vez de ser
  cortado como um identificador de chamadas.
- **O identificador de chamadas precisa estar visível.** Uma operadora que oculta o número de origem
  não deixa nada para ser lido.

Defina `WA_FLASH_CODE_LEN` se o servidor de um número esperar um comprimento diferente dos
seis dígitos que o app usa por padrão.

**Defina o nome de exibição da conta durante o registro** com `--name`. Esse é o
nome que as pessoas que *não* salvaram seu número veem ao lado dele — nas
listas de participantes de grupos, nas notificações e junto às suas mensagens. Use aspas se ele
contiver espaços:

```sh
wa registration --request-code 919634847671 --name "Ricardo Trade"
```

O nome é guardado junto com a sessão e anunciado em toda conexão a partir de
então. O registro em si não carrega nome nenhum — o servidor o descobre quando a sessão
se conecta — então um número registrado sem `--name` não tem nome até que um seja definido.
Ele pode ser informado em qualquer um dos dois passos do registro, e alterado depois com `/name`.

**Registrar como Android** é o mesmo comando, com a plataforma indicada. Nada
mais a preparar — veja [o que acontece por trás desse único comando](#registrando-como-android).

Linux, macOS, Termux:

```sh
WA_OS=android WA_DEVICE=samsung-s24-ultra wa registration --request-code 919634847671 --debug
```

Windows, Prompt de Comando — `set` em uma linha própria, porque `VAR=value` na frente de
um comando é sintaxe Unix e o Windows a recusa:

```bat
set WA_OS=android
set WA_DEVICE=samsung-s24-ultra
wa registration --request-code 919634847671 --debug
```

Windows, PowerShell:

```powershell
$env:WA_OS = "android"
$env:WA_DEVICE = "samsung-s24-ultra"
wa registration --request-code 919634847671 --debug
```

Um arquivo `.env` no diretório de onde você executa funciona igual em qualquer sistema e evita
repetir tudo isso — veja [Início Rápido de Dispositivo](#início-rápido-de-dispositivo). O `--debug` imprime
cada requisição e resposta, o que vale a pena ter na primeira vez: a primeira linha dele
nomeia a plataforma que realmente foi enviada, para você ver se as variáveis
chegaram.

As variáveis só importam para o comando que *cria* a sessão. Aquilo com que uma
sessão foi registrada fica gravado dentro dela, então o passo de confirmação e todas as
conexões posteriores seguem a sessão, e não o que o shell estiver carregando na hora.

A CLI envia a solicitação do código, imprime o resultado e então **continua aberta** no shell interativo. Você verá:

```
requesting sms code for +919634847671...
  status  sent
  now run: wa registration --register 919634847671 --code <code>

staying in shell — use /reg confirm 919634847671 <code> to complete
wa>
```

**Passo 2 — confirme o código que você recebeu**

Você pode rodar o comando direto:

```sh
wa registration --register 919634847671 --code 123456
```

Ou digitá-lo no shell que continuou aberto:

```sh
wa> /reg confirm 919634847671 123456
```

Em caso de sucesso você verá:

```
registered  session saved to /home/user/.waSession/919634847671/919634847671.json
now run: /connect 919634847671
```

**Verifique se um número já tem WhatsApp**

```sh
wa registration --check 919634847671
```

Saída:

```
checking +919634847671...
  status  registered
```

Status possíveis: `registered` · `registered_blocked` · `not_registered` · `cooldown` · `unknown`

### CLI Conectar

Depois de registrar, conecte-se com:

```sh
wa connect 919634847671
```

O shell abre com um prompt persistente:

```
connecting to +919634847671...
connected as +919634847671
wa +919634847671>
```

> [!TIP]
> **O shell nunca sai sozinho.** Ele fica aberto até você digitar `/quit` ou pressionar Ctrl+C. Isso vale para todo comando — registro, conexão, envio de mensagens — tudo.

Use uma pasta de autenticação diferente com `--session`:

```sh
wa connect 919634847671 --session /data/my-sessions
```

A CLI pergunta uma única vez, na primeira execução, como chamar essa pasta, e guarda a resposta em
`~/.whalibmob.json`. Cada número ganha a sua própria pasta lá dentro — veja
[Salvando e Restaurando Sessões](#salvando-e-restaurando-sessões).

> [!IMPORTANT]
> **Se isso for recusado com `405`, não registre o número de novo.** A conta
> está bem; o servidor recusou a versão que a conexão anunciou. Verifique se existe uma
> `WA_VERSION` no seu shell ou em um arquivo `.env` no diretório de onde você rodou o
> comando — ela sobrescreve a versão com que a sessão foi registrada, e uma versão
> velha deixada ali recusa toda conexão feita a partir daquele diretório. Veja
> [Quando o servidor responde 405 na conexão](#quando-o-servidor-responde-405-na-conexão).

### CLI Código de Pareamento

Se o número já estiver em uso em um celular, ou se o SMS de verificação nunca chegar, vincule-se à conta existente.

O `wa connect` descobre para qual dos dois modos um número está configurado lendo os arquivos de sessão dele, e informa qual escolheu:

```
connecting as companion (pairing code)...
```

Um número pode ter os dois — registrado por SMS como dispositivo próprio, e vinculado como companion a outra conta. Quando ele tem os dois, vence o que foi usado mais recentemente. Um registro pela metade não conta como sessão de jeito nenhum. Quando não há nada com que conectar, ele avisa e nomeia os dois comandos que criariam uma sessão, em vez de escolher um lado.

Force um dos dois:

```sh
wa connect 919634847671 --sms
wa connect 919634847671 --pair
```

Ou vá direto para a vinculação:

```sh
wa pair 919634847671
```

```
linking +919634847671 to an existing WhatsApp account...
────────────────────────────────────────────────────────
  pairing code   K7M2-QX4B
────────────────────────────────────────────────────────
  on the phone that owns +919634847671:
    WhatsApp → Settings → Linked Devices → Link a device
    → Link with phone number instead → enter the code above

  the code is valid for a few minutes; waiting...

  linked as 919634847671:7@s.whatsapp.net  (112713111982325:7@lid)
  device slot 7  ·  primary is android
  finishing handshake...
connected as +919634847671  (web / companion)
  history  INITIAL_BOOTSTRAP  chats=214  contacts=486
wa +919634847671>
```

Uma vez vinculado, o `wa connect` simples reconecta sem pedir um código novo. Para escolher o seu próprio código, passe-o como segundo argumento — exatamente 8 caracteres:

```sh
wa pair 919634847671 MYCODE12
```

O prompt de debug funciona igual nos dois modos. Responda `y` na inicialização, ou passe `--debug`, para ver cada stanza da troca de pareamento:

```sh
wa pair 919634847671 --debug
```

De dentro do shell:

```sh
wa> /pair 919634847671
wa> /connect 919634847671 pair
wa> /connect 919634847671 sms
```

### Modo de Escuta

Conecta e imprime todos os eventos recebidos no terminal. O processo continua vivo indefinidamente até você pressionar Ctrl+C:

```sh
wa listen 919634847671
```

Saída conforme as mensagens chegam:

```
connected  listening on +919634847671  (Ctrl+C to stop)
  ────────────────────────────────────────────────────────
  time                    2025-03-13 10:00:05
  from                    919634847671@s.whatsapp.net
  id                      3EB0ABCDEF123456
  text                    Hello there!
```

---

## CLI — Comandos do Shell Interativo

Depois de rodar `wa connect <phone>`, todo recurso da biblioteca fica disponível como um `/comando`. Digite `/help` a qualquer momento para ver todos os comandos.

> [!NOTE]
> Os JIDs podem ser escritos como números de telefone simples (ex.: `919634847671`) — o shell acrescenta `@s.whatsapp.net` automaticamente. Para grupos, use o JID completo com `@g.us`.

### Comandos de Mensagens

#### Enviar Texto

```sh
wa> /send 919634847671 Hello, how are you?
sent  3EB0ABCDEF123456

# to a group
wa> /send 120363000000000000@g.us Hello everyone!
```

#### Enviar Imagem

```sh
wa> /image 919634847671 ./photo.jpg
wa> /image 919634847671 ./photo.jpg Look at this!
```

O segundo argumento é o caminho do arquivo. O terceiro argumento, opcional, é a legenda.

#### Enviar Vídeo

```sh
wa> /video 919634847671 ./clip.mp4
wa> /video 919634847671 ./clip.mp4 Watch this
```

#### Enviar Áudio

Envia o arquivo como um anexo de áudio comum:

```sh
wa> /audio 919634847671 ./song.mp3
```

#### Enviar Mensagem de Voz

Envia o arquivo como uma mensagem de voz (push-to-talk) com forma de onda:

```sh
wa> /ptt 919634847671 ./voice.ogg
```

#### Enviar Documento

```sh
wa> /doc 919634847671 ./report.pdf
wa> /doc 919634847671 ./report.pdf "Q1 Report.pdf"
```

O terceiro argumento, opcional, sobrescreve o nome de arquivo exibido.

#### Enviar Figurinha

O arquivo precisa estar no formato WebP:

```sh
wa> /sticker 919634847671 ./sticker.webp
```

#### Enviar Enquete (CLI)

Separe a pergunta das opções usando `|`. São necessárias pelo menos duas opções. Opcionalmente acrescente `selectable=N` para limitar quantas opções cada votante pode escolher (0 = qualquer quantidade):

```sh
# single-choice poll (selectable=1)
wa> /poll 919634847671 Best language? | JavaScript | Python | Rust | selectable=1

# unlimited-choice poll (default)
wa> /poll 120363000000000000@g.us Pick your favourites | Red | Green | Blue
```

#### Reagir a uma Mensagem

```sh
wa> /react 919634847671 3EB0ABCDEF123456 👍

# remove a reaction — pass a space or empty string
wa> /react 919634847671 3EB0ABCDEF123456 " "
```

O ID da mensagem aparece na exibição da mensagem recebida como `id`.

#### Editar uma Mensagem

> [!NOTE]
> A edição só é possível dentro de 15 minutos após o envio original.

```sh
wa> /edit 919634847671 3EB0ABCDEF123456 Corrected text here
```

#### Apagar uma Mensagem

```sh
# delete for yourself only
wa> /delete 919634847671 3EB0ABCDEF123456

# delete for everyone (revoke)
wa> /delete 919634847671 3EB0ABCDEF123456 all
```

#### Publicar um Status / Story

Publica um Status de texto visível para os seus contatos:

```sh
wa> /status Good morning everyone!
```

#### Encaminhar uma Mensagem

Envia uma mensagem com a marcação de encaminhada:

```sh
wa> /forward 919634847671 This message was forwarded
```

#### Responder a uma Mensagem (CLI)

Cita e responde a uma mensagem específica. Você precisa do ID da mensagem (mostrado como `id:` no log de recebimento) e do JID de quem enviou.

```sh
# DM — senderJid is the same as the chat JID
wa> /reply 919634847671 3EB0XXXXXXXX 919634847671 Got it, thanks!

# Group — senderJid is the member who sent the original message
wa> /reply 120363000000000000@g.us 3EB0XXXXXXXX 919634847671 Agreed!
```

O ID da mensagem é impresso quando uma mensagem chega:
```
  id                    3EB0C5BA7XXXXXXXX
```

#### Enviar Localização (CLI)

Envia um pino de localização GPS. Latitude e longitude são obrigatórias; nome e endereço (separados por `|`) são opcionais:

```sh
# lat/lon only
wa> /location 919634847671 48.8566 2.3522

# with name
wa> /location 919634847671 48.8566 2.3522 Eiffel Tower

# with name and address (separate with |)
wa> /location 919634847671 48.8566 2.3522 Eiffel Tower | Champ de Mars, Paris

# to a group
wa> /location 120363000000000000@g.us 51.5074 -0.1278 London
```

#### Enviar Contato / vCard (CLI)

Envia um cartão de contato. A string do vCard precisa seguir o formato vCard v3. Coloque-a entre aspas no shell:

```sh
wa> /vcard 919634847671 "Alice Smith" "BEGIN:VCARD\nVERSION:3.0\nFN:Alice Smith\nTEL;TYPE=CELL:+919634847671\nEND:VCARD"
```

Para vCards de várias linhas, o mais fácil é guardar a string em uma variável do shell:

```sh
VCARD="BEGIN:VCARD
VERSION:3.0
FN:Alice Smith
TEL;TYPE=CELL:+919634847671
EMAIL:alice@example.com
END:VCARD"

wa> /vcard 919634847671 "Alice Smith" "$VCARD"
```

---

### Comandos de Presença

#### Definir Online / Offline

```sh
wa> /online
wa> /offline
```

#### Indicadores de Digitando e Gravando

```sh
# show "typing…" in a chat
wa> /typing 919634847671

# show "recording audio…" in a chat
wa> /recording 919634847671

# stop the indicator
wa> /stop 919634847671
```

#### Assinar a Presença de um Contato

Assina os eventos de online/offline de um contato. O shell imprime as atualizações de presença conforme elas chegam:

```sh
wa> /subscribe 919634847671
subscribed to 919634847671@s.whatsapp.net

# when they come online:
  presence  919634847671@s.whatsapp.net  online
```

---

### Comandos de Perfil

#### CLI Alterar Nome de Exibição

```sh
wa> /name My Bot Name
name updated
```

#### CLI Alterar Texto do Recado

```sh
wa> /about Available 24/7 for support
about updated
```

`about updated` agora significa que o recado foi lido de volta do servidor e confere
com o que você digitou. Quando o servidor aceita a stanza mas ainda relata outra
coisa, ele avisa — e se o recado está armazenado mas oculto, ele diz qual
configuração de privacidade está escondendo o recado.

#### CLI Alterar Foto de Perfil

Lê a imagem do disco, corta em formato quadrado, redimensiona para 640×640 e envia
como sua foto de perfil. JPEG, PNG, GIF e BMP não precisam de nada instalado; WebP e
HEIC precisam de `ffmpeg` ou `jimp`.

```sh
wa> /photo ./avatar.jpg
profile picture updated  id=1753912045

wa> /photo remove
profile picture removed
```

#### CLI Alterar Configurações de Privacidade

```sh
wa> /privacy last_seen contacts
wa> /privacy profile_picture contacts
wa> /privacy status contacts
wa> /privacy online match_last_seen
wa> /privacy read_receipts none
wa> /privacy groups_add contacts
```

Tipos disponíveis: `last_seen` · `profile_picture` · `status` · `online` · `read_receipts` · `groups_add`

Valores disponíveis: `all` · `contacts` · `contact_blacklist` · `none` · `match_last_seen`

---

### Comandos de Contatos

#### Verificar Quem Tem WhatsApp

Verifica vários números de telefone (apenas dígitos, sem `+`) e lista quais estão registrados no WhatsApp:

```sh
wa> /whatsapp 919634847671 12345678901
  has whatsapp (1)
    919634847671@s.whatsapp.net
  not found (1)
    12345678901
```

#### Obter a URL da Foto de Perfil

Retorna a URL do CDN para a foto de perfil de um contato ou grupo:

```sh
wa> /picture 919634847671
  https://mmg.whatsapp.net/v/...

wa> /picture 120363000000000000@g.us
  https://mmg.whatsapp.net/v/...
```

#### Obter o Recado de um Contato

Busca a bio / texto de recado de um contato:

```sh
wa> /contact about 919634847671
  Available 24/7
```

---

### Comandos de Gerenciamento de Conversas

Em uma sessão **vinculada** (código de pareamento), esses comandos escrevem no app state, então uma
alteração feita aqui chega ao seu celular e a todos os outros dispositivos vinculados.

Em uma sessão por **SMS**, este dispositivo é o principal e não existe chave de app state
a menos que você tenha vinculado um companion a ele. `/mute`, `/unmute` e `/read` ainda
enviam a requisição que um dispositivo principal faz para si mesmo; `/pin`, `/archive` e `/star`
atualizam somente esta sessão. O comando informa o que aconteceu:

```sh
wa> /pin 919634847671
pinned  (this session only — no app state key)
```

#### Marcar como Lida / Não Lida

```sh
wa> /read   919634847671
wa> /unread 919634847671
```

#### Silenciar / Reativar Som

```sh
# mute for 60 minutes
wa> /mute 919634847671 60

# mute indefinitely
wa> /mute 919634847671

# unmute
wa> /unmute 919634847671
```

#### Fixar / Desafixar

```sh
wa> /pin   919634847671
wa> /unpin 919634847671
```

#### Arquivar / Desarquivar

```sh
wa> /archive   919634847671
wa> /unarchive 919634847671
```

#### Favoritar / Desfavoritar uma Mensagem (CLI)

Acrescente `me` quando a mensagem for uma que você enviou — isso faz parte de como o favorito é
arquivado, então omitir isso na sua própria mensagem favorita a coisa errada.

```sh
wa> /star   919634847671 3EB0ABCDEF123456 me
wa> /unstar 919634847671 3EB0ABCDEF123456
```

<a id="cli-app-state"></a>

#### Sincronizar o App State

Traz os itens fixados, arquivados, silenciados, favoritos e nomes de contato alterados no seu celular ou
em outro dispositivo vinculado. Isso acontece sozinho sempre que o servidor avisa que
algo mudou; o comando serve para puxar sob demanda.

```sh
wa> /appstate
syncing app state...
  ──────────────────────────────────────────────────
  critical_block        v3   0 change(s)
  critical_unblock_low  v18  2 change(s)
  regular_high          v7   0 change(s)
  regular_low           v41  3 change(s)
  regular               v2   0 change(s)
  total                 5 change(s) applied
  ──────────────────────────────────────────────────

# just one part of it
wa> /appstate regular_low

# throw away what we hold and re-read everything
wa> /appstate --snapshot
```

As alterações que chegam sozinhas são impressas conforme aparecem:

```sh
  pinned  919634847671@s.whatsapp.net
  muted  120363000000000000@g.us  until 2026-08-01T09:00:00.000Z
  contact  12345678901@s.whatsapp.net  → Ion
```

Se o seu celular ainda não tiver compartilhado uma chave de sincronização com esta sessão, o comando avisa
— deixe o WhatsApp aberto no celular por um instante e tente de novo.

<a id="cli-restriction"></a>

#### Contagem Regressiva de Restrição da Conta

Quando o WhatsApp restringe uma conta, novas conversas são recusadas com o erro 463 até
a restrição expirar — normalmente cerca de cinco horas na primeira vez. O `/restriction` pergunta ao
servidor quanto tempo falta e depois faz a contagem regressiva, a cada segundo, no mesmo lugar:

```sh
wa> /restriction
checking account restriction...
  ──────────────────────────────────────────────────
  status                RESTRICTED
  reason                too many people you messaged blocked or reported you
  type                  BIZ_QUALITY
  ends at               2026-07-28 19:41:12 UTC
  remaining             04:59:22
  ──────────────────────────────────────────────────
  New chats with people you have never messaged are refused with
  error 463 until this expires. Existing conversations keep working,
  and sending more only makes the restriction longer.

  press any key to stop watching
  restricted — 04:59:20 remaining
```

A última linha se reescreve a cada segundo — `04:59:20`, `04:59:19`, … — e
para sozinha no momento em que a restrição é levantada. Qualquer tecla encerra o acompanhamento; a
restrição não é afetada de nenhuma forma. `/limit` é o mesmo comando.

Para ver os números sem a contagem regressiva:

```sh
wa> /restriction --once
```

Para conferir a exibição sem precisar esperar ser restringido, o `--demo` faz a contagem regressiva de
uma restrição inventada. Nada é enviado, nada é pedido ao servidor e
nada fica para trás quando termina:

```sh
wa> /restriction --demo
  ──────────────────────────────────────────────────
  status                RESTRICTED  (demo — not real)
  reason                too many people you messaged blocked or reported you
  remaining             05:00:00
  ──────────────────────────────────────────────────
  press any key to stop watching
  restricted — 04:59:57 remaining
```

`--demo 90` usa noventa segundos em vez das cinco horas padrão, o que é
curto o bastante para você ver a contagem chegar a zero e parar sozinha.


Uma conta que está tudo bem avisa e retorna imediatamente:

```sh
wa> /restriction
checking account restriction...
  ──────────────────────────────────────────────────
  status                not restricted — you can start new chats
  ──────────────────────────────────────────────────
```

Você não precisa rodar o comando para descobrir. Um envio recusado verifica sozinho, e o
shell imprime a mudança na hora em que ela acontece:

```sh
  ACCOUNT RESTRICTED — too many people you messaged blocked or reported you, 04:59:58 remaining
  run /restriction to watch the countdown
```

#### CLI Mensagens Temporárias

| Duração | Segundos |
|---|---|
| Desligado | 0 |
| 24 horas | 86400 |
| 7 dias | 604800 |
| 90 dias | 7776000 |

```sh
# set 1-day timer on a DM
wa> /ephemeral 919634847671 86400

# set 1-week timer on a group
wa> /ephemeral 120363000000000000@g.us 604800

# turn off
wa> /ephemeral 919634847671 0
```

#### Temporizador Padrão de Mensagens Temporárias

Define o temporizador efêmero padrão global aplicado a todas as **novas** conversas:

```sh
wa> /ephemeral-default 86400
default ephemeral set  86400

# turn off
wa> /ephemeral-default 0
default ephemeral set  0
```

Aceita os mesmos valores de `/ephemeral`: 0, 86400, 604800, 7776000.

#### Bloquear / Desbloquear

```sh
wa> /block   919634847671
blocked  919634847671@s.whatsapp.net

wa> /unblock 919634847671
unblocked  919634847671@s.whatsapp.net
```

#### Ver a Lista de Bloqueados

```sh
wa> /blocklist
  blocked (2)
    919634847671@s.whatsapp.net
    12345678901@s.whatsapp.net
```

---

### Comandos de Grupos

#### CLI Criar um Grupo

```sh
wa> /group create MyGroup 919634847671 12345678901
creating group...
created  120363000000000000@g.us
  subject  MyGroup
  members  919634847671@s.whatsapp.net, 12345678901@s.whatsapp.net
```

#### CLI Sair de um Grupo

```sh
wa> /group leave 120363000000000000@g.us
left  120363000000000000@g.us
```

#### Adicionar / Remover Participantes

```sh
# add participants
wa> /group add 120363000000000000@g.us 919634847671 12345678901
  added  919634847671@s.whatsapp.net
  failed  12345678901@s.whatsapp.net  — their privacy settings do not allow it (403)  · can be invited instead

# remove participants
wa> /group remove 120363000000000000@g.us 919634847671
  removed  919634847671@s.whatsapp.net
```

Vários participantes podem ser listados, separados por espaços. Cada participante é
reportado em sua própria linha, porque o servidor decide cada um separadamente.

#### Promover / Rebaixar Administradores

```sh
# promote to admin
wa> /group promote 120363000000000000@g.us 919634847671

# demote from admin
wa> /group demote 120363000000000000@g.us 919634847671
```

#### Alterar o Nome do Grupo

```sh
wa> /group subject 120363000000000000@g.us New Group Name
subject updated
```

#### Alterar a Descrição do Grupo

```sh
wa> /group desc 120363000000000000@g.us This is the group for project updates
description updated
```

#### Alterar a Foto do Grupo

Lê a imagem do disco e a define como foto de perfil do grupo. Você precisa ser administrador.

```sh
wa> /group photo 120363000000000000@g.us ./group-logo.jpg
group picture updated  id=1705315800
```

#### Obter o Link de Convite

```sh
wa> /group invite 120363000000000000@g.us
  https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv
```

#### Revogar o Link de Convite

Invalida o link de convite atual e gera um novo:

```sh
wa> /group revoke 120363000000000000@g.us
invite link revoked
```

#### Entrar em um Grupo pelo Código de Convite

Passe apenas a parte do código — não inclua `https://chat.whatsapp.com/`:

```sh
wa> /group join AbCdEfGhIjKlMnOpQrStUv
joined  120363000000000000@g.us
```

#### Consultar Informações do Convite de Grupo

Pré-visualize os metadados de um grupo a partir de um link de convite **antes** de entrar. Aceita o código puro ou a URL completa:

```sh
wa> /group invite-info AbCdEfGhIjKlMnOpQrStUv
  ────────────────────────────────────────────────────────
  jid                   120363000000000000@g.us
  subject               My Group
  creator               919634847671@s.whatsapp.net
  created               2024-01-15 10:30:00
  description           Group description here
  participants          (3)
    919634847671@s.whatsapp.net  [admin]
    12345678901@s.whatsapp.net
    98765432109@s.whatsapp.net
  ────────────────────────────────────────────────────────
```

Você também pode passar o link completo:

```sh
wa> /group invite-info "https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv"
```

#### Consultar Metadados do Grupo

```sh
wa> /group meta 120363000000000000@g.us
  jid                   120363000000000000@g.us
  subject               My Group
  creator               919634847671@s.whatsapp.net
  created               2024-01-15T10:30:00.000Z
  description           Group description here
  ephemeral             off
  only admins send      no
  only admins edit      yes
  join approval         required
  who can add           admins only
  size                  3
  participants          (3)
    112713111982325@lid  (919634847671@s.whatsapp.net)  [admin]
    229063524376784@lid  (12345678901@s.whatsapp.net)
    98765432109@s.whatsapp.net
```

Um participante endereçado por LID aparece com o número de telefone por trás dele quando
o servidor envia um. Duas linhas a mais aparecem apenas quando se aplicam:

```sh
  suspended             yes — this group has been taken down
  incognito             yes — phone numbers are hidden
```

Um grupo suspenso responde a todo envio com uma recusa e mais nada, então vale
conferir isso aqui antes de sair caçando a causa em outro lugar.

#### Listar Todos os Grupos

Busca todos os grupos dos quais você é membro e imprime uma lista numerada:

```sh
wa> /groups
  groups (3)
    1  120363000000000000@g.us  My Project Group  (5 members)
    2  120363111111111111@g.us  Family Chat        (12 members)
    3  120363222222222222@g.us  Friends            (8 members)
```

#### Listar Participantes do Grupo

Lista todos os participantes de um grupo com seus papéis:

```sh
wa> /group participants 120363000000000000@g.us
  My Group  (3 participants)
    112713111982325@lid  (919634847671@s.whatsapp.net)  [admin]
    229063524376784@lid  (12345678901@s.whatsapp.net)
    98765432109@s.whatsapp.net
```

#### Solicitações de Entrada Pendentes

Lista os usuários que pediram para entrar em um grupo (só fica visível quando `approve_participants` está ativado):

```sh
wa> /group pending 120363000000000000@g.us
  pending (2)
    919634847671@s.whatsapp.net   2026-07-20T09:12:00.000Z
    12345678901@s.whatsapp.net    2026-07-21T14:03:20.000Z
```

#### Aprovar / Recusar Solicitações de Entrada

```sh
# approve one or more pending members
wa> /group approve 120363000000000000@g.us 919634847671
  approved  919634847671@s.whatsapp.net

# reject one or more pending members
wa> /group reject 120363000000000000@g.us 919634847671
  rejected  919634847671@s.whatsapp.net
```

Vários JIDs podem ser listados, separados por espaços. Quem o servidor não deixar
passar é listado separadamente com o motivo.

<a id="cli-personal-invitations"></a>

#### Convites Pessoais

Para alguém cujas configurações de privacidade não permitem que seja adicionado diretamente a um grupo,
o `add-invite` adiciona quem for possível e envia aos demais um convite pessoal:

```sh
wa> /group add-invite 120363000000000000@g.us 919634847671 12345678901
  added  919634847671@s.whatsapp.net
  failed  12345678901@s.whatsapp.net  — their privacy settings do not allow it (403)  · can be invited instead  · invitation sent
```

Um convite que chega para você mostra o comando que o aceita:

```sh
  message from      919634847671@s.whatsapp.net
  id                3EB0A1B2C3D4
  type              group invitation  My Group
  accept with       /group accept-invite 120363000000000000@g.us 919634847671@s.whatsapp.net AbCdEfGh 1790000000
```

```sh
# look at the group without joining it
wa> /group preview-invite 120363000000000000@g.us 919634847671 AbCdEfGh 1790000000

# join
wa> /group accept-invite 120363000000000000@g.us 919634847671 AbCdEfGh 1790000000
joined 120363000000000000@g.us

# send one by hand
wa> /group send-invite 120363000000000000@g.us 12345678901 AbCdEfGh 1790000000

# take one back before it is used
wa> /group revoke-invite 120363000000000000@g.us 12345678901
```

#### Configurações do Grupo

Controla quem pode enviar mensagens, editar as informações do grupo, adicionar participantes, ou exige aprovação para entrar:

```sh
# only admins can send messages
wa> /group settings 120363000000000000@g.us send_messages admins

# everyone can send messages
wa> /group settings 120363000000000000@g.us send_messages all

# only admins can edit group info
wa> /group settings 120363000000000000@g.us edit_group_info admins

# only admins can add participants
wa> /group settings 120363000000000000@g.us add_participants admins

# require admin approval for join requests
wa> /group settings 120363000000000000@g.us approve_participants admins
```

---

### Comandos de Comunidades (CLI)

As comunidades reúnem vários grupos vinculados sob um mesmo guarda-chuva. Apenas o criador da comunidade pode vincular / desvincular grupos ou desativar a comunidade.

```sh
# create a community (description is optional)
wa> /community create "Dev Squad" "Our developer community"

# link an existing group into the community
wa> /community link  120363000000000001@g.us 120363000000000002@g.us

# unlink a group from the community
wa> /community unlink 120363000000000001@g.us 120363000000000002@g.us

# permanently deactivate (delete) a community
wa> /community deactivate 120363000000000001@g.us
```

---

### Comandos de Newsletter / Canal

As newsletters são canais de transmissão um-para-muitos. Só o dono pode publicar; qualquer pessoa pode se inscrever.

```sh
# create a new channel
wa> /newsletter create Tech News Daily tips about technology

# subscribe to a channel
wa> /newsletter join 120363000000000004@newsletter

# unsubscribe from a channel
wa> /newsletter leave 120363000000000004@newsletter

# query channel metadata (name, description, subscriber count)
wa> /newsletter info 120363000000000004@newsletter
  ────────────────────────────────────────────────────────
  jid           120363000000000004@newsletter
  name          Tech News
  description   Daily tips about technology
  subscribers   1234
  ────────────────────────────────────────────────────────

# update the channel description (you must be the owner)
wa> /newsletter desc 120363000000000004@newsletter New description here

# post a text update to your channel (you must be the owner)
wa> /newsletter post 120363000000000004@newsletter Breaking: WhatsApp adds polls!
```

---

### Comando de Perfil Comercial (CLI)

Consulta o perfil comercial público de qualquer conta WhatsApp Business:

```sh
wa> /biz 919634847671
  ────────────────────────────────────────────────────────
  jid           919634847671@s.whatsapp.net
  category      Software & IT Services
  email         contact@example.com
  website       https://example.com
  address       123 Main St
  description   We build software
  ────────────────────────────────────────────────────────
```

Retorna uma mensagem se o número não for uma conta WhatsApp Business.

---

### Comandos de Registro (no shell)

Estes comandos funcionam de dentro do shell — úteis quando você precisa registrar um segundo número sem fechar a sessão atual:

```sh
# check if a phone number has WhatsApp
wa> /reg check 919634847671

# request a verification code
wa> /reg code 919634847671
wa> /reg code 919634847671 voice
wa> /reg code 919634847671 wa_old

# register with a display name — what people who have not saved
# your number see. Quote it if it has spaces.
wa> /reg code 919634847671 --name "Ricardo Trade"

# confirm the code received
wa> /reg confirm 919634847671 123456
registered  session saved to /home/user/.waSession/919634847671/919634847671.json
now run: /connect 919634847671
```

**Registrar como Android a partir do shell** funciona da mesma forma, mas o `WA_OS` precisa
estar definido quando o shell *inicia* — o prompt `wa>` já está dentro de um processo em
execução, e nada digitado nele consegue mudar o ambiente com o qual aquele processo
foi iniciado:

```sh
WA_OS=android WA_DEVICE=samsung-s24-ultra wa
```
```sh
wa> /reg code 919634847671
no Android token material yet — fetching the WhatsApp APK from Google Play
  ...
  status  sent
wa> /reg confirm 919634847671 123456
```

Um arquivo `.env` com `WA_OS=android` no diretório de onde você inicia faz a mesma coisa
e evita a digitação. De qualquer forma, isso só importa para o comando que *cria*
a sessão: aquilo com que a sessão foi registrada fica gravado nela, e todo passo posterior
— a confirmação, uma reconexão a partir de outro shell amanhã — segue
a sessão, e não o ambiente.

---

### Comandos de Conexão (no shell)

```sh
# connect to a number (while already in the shell)
# picks sms or pairing from the session files on disk
wa> /connect 919634847671

# force one or the other
wa> /connect 919634847671 sms
wa> /connect 919634847671 pair

# link to an existing account by 8-digit pairing code
wa> /pair 919634847671

# or link by scanning a QR drawn in the terminal
wa> /qrcode 919634847671

# with a code you chose yourself (exactly 8 characters)
wa> /pair 919634847671 MYCODE12

# disconnect
wa> /disconnect

# force a reconnection
wa> /reconnect

# show current session info
wa> /session
  phone                   919634847671
  name                    My Bot
  session                 /home/user/.waSession

# show all available commands
wa> /help

# disconnect and exit the shell
wa> /quit
```

---

### Tabela Completa de Referência de Comandos

| Comando | Descrição |
|---|---|
| **Mensagens** | |
| `/send <jid> <text>` | Envia uma mensagem de texto |
| `/image <jid> <file> [caption]` | Envia uma imagem |
| `/video <jid> <file> [caption]` | Envia um vídeo |
| `/audio <jid> <file>` | Envia um arquivo de áudio |
| `/ptt <jid> <file>` | Envia uma mensagem de voz (push-to-talk) |
| `/doc <jid> <file> [name]` | Envia um documento |
| `/sticker <jid> <file>` | Envia uma figurinha (.webp) |
| `/poll <jid> <question> \| <opt1> \| <opt2> [selectable=N]` | Envia uma enquete |
| `/react <jid> <msgId> <emoji>` | Reage a uma mensagem |
| `/edit <jid> <msgId> <text>` | Edita uma mensagem enviada |
| `/delete <jid> <msgId> [all]` | Apaga uma mensagem (use `all` para todos) |
| `/status <text>` | Publica um Status / Story |
| `/forward <jid> <text>` | Envia com a marcação de encaminhada |
| `/reply <jid> <msgId> <senderJid> <text>` | Responde citando uma mensagem específica |
| `/location <jid> <lat> <lon> [name] [| address]` | Envia um pino de localização GPS |
| `/vcard <jid> <displayName> <vcard>` | Envia um cartão de contato (vCard v3) |
| **Presença** | |
| `/online` | Define você como online |
| `/offline` | Define você como offline |
| `/typing <jid>` | Mostra o indicador de digitando em uma conversa |
| `/recording <jid>` | Mostra o indicador de gravando áudio |
| `/stop <jid>` | Para o indicador de digitando / gravando |
| `/subscribe <jid>` | Assina a presença de um contato |
| **Perfil** | |
| `/name <text>` | Altera o seu nome de exibição |
| `/about <text>` | Altera a sua bio / texto de recado |
| `/photo <file>` | Altera a sua foto de perfil |
| `/privacy <type> <value>` | Altera uma configuração de privacidade |
| **Contatos** | |
| `/whatsapp <phone...>` | Verifica quais números têm WhatsApp |
| `/picture <jid>` | Obtém a URL do CDN da foto de perfil |
| `/contact about <jid>` | Obtém a bio / recado de um contato |
| **Gerenciamento de Conversas** | |
| `/read <jid>` | Marca a conversa como lida |
| `/unread <jid>` | Marca a conversa como não lida |
| `/mute <jid> [minutes]` | Silencia uma conversa (indefinidamente se nenhum minuto for informado) |
| `/unmute <jid>` | Reativa o som de uma conversa |
| `/pin <jid>` | Fixa uma conversa |
| `/unpin <jid>` | Desafixa uma conversa |
| `/archive <jid>` | Arquiva uma conversa |
| `/unarchive <jid>` | Desarquiva uma conversa |
| `/star <jid> <msgId> [me]` | Favorita uma mensagem (`me` se foi você quem enviou) |
| `/unstar <jid> <msgId> [me]` | Desfavorita uma mensagem |
| `/appstate [collection...]` | Puxa fixados/arquivados/silenciados/favoritos do seu celular |
| `/appstate --snapshot` | Relê todo o app state do zero |
| `/restriction` | Status de restrição da conta com contagem regressiva ao vivo |
| `/restriction --once` | Status de restrição sem a contagem regressiva |
| `/restriction --demo [seconds]` | Contagem regressiva falsa, para conferir a exibição |
| `/limit` | Apelido para `/restriction` |
| `/ephemeral <jid> <seconds>` | Define o temporizador de mensagens temporárias de uma conversa |
| `/ephemeral-default <seconds>` | Define o temporizador efêmero padrão global para novas conversas |
| `/block <jid>` | Bloqueia um contato |
| `/unblock <jid>` | Desbloqueia um contato |
| `/blocklist` | Mostra todos os contatos bloqueados |
| **Grupos** | |
| `/group create <name> <jid...>` | Cria um grupo |
| `/group leave <jid>` | Sai de um grupo |
| `/group add <jid> <member...>` | Adiciona participantes |
| `/group remove <jid> <member...>` | Remove participantes |
| `/group promote <jid> <member...>` | Promove a administrador |
| `/group demote <jid> <member...>` | Rebaixa de administrador |
| `/group subject <jid> <name>` | Renomeia o grupo |
| `/group desc <jid> <text>` | Altera a descrição do grupo |
| `/group photo <jid> <file>` | Altera a foto do grupo |
| `/group invite <jid>` | Obtém o link de convite |
| `/group revoke <jid>` | Revoga o link de convite |
| `/group join <code>` | Entra em um grupo pelo código de convite |
| `/group invite-info <code\|url>` | Pré-visualiza os metadados do grupo a partir de um link de convite (sem entrar) |
| `/groups` | Lista todos os grupos dos quais você é membro |
| `/group meta <jid>` | Consulta os metadados do grupo |
| `/group participants <jid>` | Lista os participantes do grupo com seus papéis |
| `/group pending <jid>` | Lista as solicitações de entrada pendentes |
| `/group approve <jid> <member...>` | Aprova solicitações de entrada pendentes |
| `/group reject <jid> <member...>` | Recusa solicitações de entrada pendentes |
| `/group settings <jid> <setting> <policy>` | Altera uma configuração do grupo |
| **Comunidade** | |
| `/community create <subject> [description]` | Cria uma comunidade |
| `/community deactivate <communityJid>` | Exclui permanentemente uma comunidade |
| `/community link <communityJid> <groupJid>` | Vincula um grupo a uma comunidade |
| `/community unlink <communityJid> <groupJid>` | Desvincula um grupo de uma comunidade |
| **Newsletter / Canal** | |
| `/newsletter create <name> [description]` | Cria um canal de newsletter |
| `/newsletter join <jid>` | Inscreve-se em um canal |
| `/newsletter leave <jid>` | Cancela a inscrição em um canal |
| `/newsletter info <jid>` | Consulta os metadados do canal |
| `/newsletter desc <jid> <text>` | Atualiza a descrição do canal |
| `/newsletter post <jid> <text>` | Publica uma atualização de texto no seu canal |
| **Business** | |
| `/biz <phone\|jid>` | Consulta o perfil comercial de uma conta WhatsApp Business |
| **Registro** | |
| `/reg check <phone>` | Verifica se o número tem WhatsApp |
| `/reg code <phone> [method] [--name "Name"]` | Solicita o código de verificação, opcionalmente nomeando a conta |
| `/reg confirm <phone> <code> [--name "Name"]` | Conclui o registro |
| **Conexão** | |
| `/connect <phone> [sms\|pair]` | Conecta ao WhatsApp — escolhe o método pelos arquivos de sessão quando não informado |
| `/pair <phone> [code]` | Vincula a uma conta existente por código de pareamento de 8 dígitos |
| `/qrcode <phone>` | Vincula a uma conta existente escaneando um QR desenhado no terminal |
| `/disconnect` | Desconecta a sessão atual |
| `/reconnect` | Força uma reconexão |
| `/session` | Mostra as informações da sessão |
| `/help` | Mostra todos os comandos |
| `/quit` / `/exit` | Desconecta e sai |

---

## API da Biblioteca

Tudo o que a CLI faz está disponível como biblioteca Node.js. As seções abaixo
cobrem a conexão de uma conta, o envio e o recebimento de todos os tipos de mensagem, grupos,
comunidades, canais, presença, privacidade, sincronização de histórico e emulação de dispositivo.

## Conectando a Conta

### Registrar um Novo Número

O registro é um processo feito uma única vez. Você precisa de um número de telefone que consiga receber um SMS ou uma chamada de voz.

**Passo 1 — solicite um código de verificação**

```js
const {
  createNewStore, saveStore, requestSmsCode
} = require('whalibmob')
const path = require('path')
const fs   = require('fs')

const phone    = '919634847671'           // country code + number, no '+'
const sessDir  = path.join(process.env.HOME, '.waSession')
const sessFile = path.join(sessDir, phone + '.json')

fs.mkdirSync(sessDir, { recursive: true })

// `name` is the display name the account registers with — what people who have
// not saved the number see. Omit it and the account has no name until one is
// set later with client.changeName().
const store = createNewStore(phone, { name: 'Ricardo Trade' })
saveStore(store, sessFile)

await requestSmsCode(store, 'sms')   // 'sms' | 'voice' | 'wa_old'
```

O nome é gravado na sessão, e não enviado ao endpoint de registro — o
servidor o descobre na primeira conexão, e em todas as seguintes. Ele também pode
ser passado como opção em qualquer um dos dois passos, que é a maneira de nomear uma sessão
que já existe:

```js
await requestSmsCode(store, 'sms', { name: 'Ricardo Trade' })
await verifyCode(store, '123456',  { name: 'Ricardo Trade' })
```

Os nomes têm espaços aparados, espaços múltiplos reduzidos a um só e são limitados a 25 caracteres.

**Passo 2 — verifique o código**

```js
const { loadStore, saveStore, verifyCode } = require('whalibmob')

const store  = loadStore(sessFile)
const result = await verifyCode(store, '123456')

if (result.status === 'ok') {
  saveStore(result.store, sessFile)
  console.log('registered')
}
```

**Opcional — deixe o código chegar sozinho.** Os dois passos acima são o fluxo inteiro, e nada neles muda se você não fizer mais nada. Mas como um registro Android envia um token push do Firebase (veja [O Push Token](#o-push-token)), o WhatsApp *pode* também entregar o código de seis dígitos como um push silencioso. Abra um listener para ele antes de solicitar o código, e o código pode voltar sem que nada seja digitado — em um perfil `WA_OS=android`; no iOS ele resolve `null` de imediato, já que só o Firebase está implementado:

```js
const { receivePushCode } = require('whalibmob')

// open the listener FIRST, so the push has somewhere to land
const codePromise = receivePushCode(store, store.device, { timeoutMs: 180000 })

await requestSmsCode(store, 'sms')        // any method; the push is a copy of the code
const code = await codePromise            // the six digits, or null if no push came

if (code) {
  const result = await verifyCode(store, code)
  if (result.status === 'ok') saveStore(result.store, sessFile)
} else {
  // no push this time — read the code the ordinary way and call verifyCode(store, code)
}
```

Isso é puramente aditivo: o `receivePushCode` resolve `null` em caso de timeout ou qualquer falha, então o caminho comum `requestSmsCode` / `verifyCode` sempre continua por trás dele. Se o WhatsApp envia ou não o push silencioso é decisão do servidor — veja [Recebendo o código por push](#recebendo-o-código-por-push-sem-digitá-lo) para saber o que rege isso. Pela CLI, a mesma coisa é um único comando: `/reg push <phone>`.

**Quando o código não é o fim da história.** O servidor pode responder a um código enviado com um CAPTCHA, ou com uma exigência do PIN de verificação em duas etapas da conta. Nenhum dos dois é algo que a biblioteca consiga resolver sozinha, então ambos voltam para você por meio de handlers opcionais:

```js
const result = await verifyCode(store, '123456', {
  // image and audio are Buffers, or null when that variant was not sent.
  // Return the answer, or null to give up.
  async solveCaptcha({ image, audio }) {
    fs.writeFileSync('captcha.png', image)
    return await askTheUser()
  },

  // The six-digit PIN set on the phone under
  // Settings → Account → Two-step verification.
  async twoFactorPin() {
    return await askTheUser()
  }
})
```

Os dois são opcionais e os dois continuam funcionando quando omitidos — você recebe um erro nomeando o que foi pedido, em vez de uma falha silenciosa, com os blobs do CAPTCHA anexados em `err.captcha`. Uma resposta errada de CAPTCHA é respondida com outro CAPTCHA, então o `solveCaptcha` pode ser chamado várias vezes. A CLI pergunta pelos dois, gravando a imagem em um arquivo temporário primeiro.

> [!NOTE]
> O registro reporta as telas pelas quais passa ao `/client_log` do WhatsApp, do jeito que os clientes de celular fazem — um cliente que registra em silêncio total faz algo que nenhuma instalação real faz. É "dispare e esqueça" e toda falha é engolida, então isso nunca pode derrubar um registro. Defina `WA_FUNNEL_LOG=0` para não enviar nada disso.

### Registrando como Android

**Não há nada a fazer antes.** Informe a plataforma e registre:

```sh
WA_OS=android WA_DEVICE=samsung-s24-ultra wa registration --request-code 919634847671 --debug
```

O primeiro registro Android não encontra material de token, busca o APK do WhatsApp
na Google Play, lê dele o que precisa, confere se foi realmente o WhatsApp
que o assinou, e segue para a solicitação do código — um comando só, sem APK para procurar:

```
no Android token material yet — fetching the WhatsApp APK from Google Play
    version 2.26.30.3 (code 263000302)
    downloading base.apk and 1 density split (of 24 the server offered): config.xxxhdpi
    token material written to /home/you/.waSession/android-apk-material.json
requesting sms code for +919634847671...
  status  sent
```

Isso acontece uma vez. Todo registro posterior lê o arquivo. `WA_NO_APK_DOWNLOAD=1`
desliga o download, caso você prefira que ele nunca baixe cem megabytes
sem ser pedido, e o `wa apk-material` abaixo faz o mesmo trabalho manualmente.

O resto desta seção é o que acontece por trás daquele único comando, e como
conduzir cada parte você mesmo.

### Registrando uma conta WhatsApp Business

Defina `WA_BUSINESS`, ou passe `--business`, e todo o registro muda para
a build Business:

```sh
WA_OS=android WA_BUSINESS=1 wa registration --request-code 919634847671
wa registration --register 919634847671 --code 123456
wa connect 919634847671
```

Tudo que nomeia o app decorre dessa única variável:

| | consumidor | Business |
|---|---|---|
| plataforma anunciada | `ANDROID` / `IOS` | `ANDROID_BUSINESS` / `IOS_BUSINESS` |
| User-Agent | `Android/…` · `iOS/…` | `SMBA/…` · `SMB iOS/…` |
| material de token Android | `com.whatsapp` | `com.whatsapp.w4b` |
| constante de token iOS | consumidor | Business |
| consulta de versão | listagem consumidor | listagem Business |
| campo `vname` | não enviado | um certificado de nome verificado autoassinado |
| porta de atestação do Frida | 1119 | 1120 |

O material de token Android fica em um arquivo próprio
(`android-apk-material-business.json`), então as duas builds nunca sobrescrevem uma
à outra e o `wa apk-material --download --business` pode conviver ao lado do
material do consumidor.

O `vname` é um `VerifiedNameCertificate` que o próprio cliente assina, carregando um
nome vazio, o emissor `smb:wa` e um serial aleatório. O nome está vazio porque
nada foi verificado ainda — o WhatsApp emite o certificado real depois de revisar o
negócio. O que o servidor confere é que a assinatura sobre esses dados foi
feita com a chave de identidade que a mesma requisição registra.

> [!IMPORTANT]
> **Decida antes de o código sair.** Uma conta é criada como Business ou como
> consumidor, e o token, o User-Agent e o certificado precisam continuar todos
> dizendo qual dos dois. Uma sessão que já está no meio do registro mantém
> aquilo com que começou e avisa, em vez de trocar no meio do caminho; apague o
> arquivo de sessão para recomeçar como a outra opção.

#### Por que um APK está envolvido nisso

O token de registro é calculado de forma diferente em cada plataforma, e só o iOS
o deriva de uma constante. O cliente Android o assina com material tirado do
próprio APK:

```
key   = PBKDF2-HMAC-SHA1(password = "com.whatsapp" + about_logo.png,
                         salt = fixed, iterations = 128, length = 64)
token = urlencode(base64(HMAC-SHA1(key, signing certificates
                                      + MD5(classes.dex)
                                      + national number)))
```

Nada disso pode ser derivado, então tem que ser lido de um APK real uma vez. Enviar
o token no formato iOS como Android é respondido com `{"reason":"bad_token"}`, e nenhum
valor em `WA_STATIC_TOKEN` muda isso — a constante não é o que está errado, a
fórmula é. `WA_STATIC_TOKEN` se aplica somente ao iOS.

#### Baixando o APK separadamente

Isso roda sozinho em um registro que não encontra material. Para fazer separadamente
— para atualizar depois de um lançamento do WhatsApp, ou só para ver o que ele pega:

```sh
wa apk-material --download
```

O caminho é um token anônimo da Play Store obtido no dispenser da Aurora OSS, depois
os próprios endpoints `/fdfe` de catálogo e entrega do Google, e então as URLs assinadas do CDN.
**Nenhuma conta Google sua está envolvida.** Só os splits
de densidade são baixados — a chave do token vem do `about_logo.png`, que fica
em um deles, e os splits de arquitetura e idioma seriam cem
megabytes que nada aqui lê.

Duas ressalvas. O dispenser é um serviço gratuito de terceiros: quando ele está fora do ar ou
limitando requisições, isso falha e um APK tirado de um celular continua funcionando. E baixar da
Play desse jeito vai contra os termos de serviço da Play, o que é uma decisão sua.

A Play entrega os splits que combinam com o perfil de dispositivo que ela recebe na requisição, não o conjunto
completo que um bundle tem, então a densidade obtida aqui pode diferir da de um
bundle completo — e uma densidade diferente é uma chave diferente. A linha `about_logo`
na saída informa qual foi usada.

#### Lendo de um APK que você já tem

Extraia um de qualquer celular ou emulador com o WhatsApp instalado:

```sh
adb shell pm path com.whatsapp
# package:/data/app/~~xyz==/com.whatsapp-abc==/base.apk
# package:/data/app/~~xyz==/com.whatsapp-abc==/split_config.xxhdpi.apk
adb pull /data/app/~~xyz==/com.whatsapp-abc==/base.apk
adb pull /data/app/~~xyz==/com.whatsapp-abc==/split_config.xxhdpi.apk
```

Os lançamentos recentes vêm como App Bundle, então o `about_logo.png` muitas vezes fica em um
split de densidade em vez de no `base.apk`. Extraia também os arquivos `split_config.*dpi.apk`
e passe-os junto — só os splits cujo nome termina em `dpi` são vasculhados.

**Leia o material dele:**

```sh
wa apk-material base.apk split_config.xxhdpi.apk
```

```
reading base.apk...
  package               com.whatsapp
  version               2.26.25.80  (code 260908001)
  certificates          1
  signed by             C=US, ST=California, L=Santa Clara, O=WhatsApp Inc., …
  sha256                AD:AD:64:31:29:8F:64:2B:…
  classes.dex md5       5c71f02aaad331e16e436bfa83ea3c5b
  written to            /home/you/.waSession/android-apk-material.json
```

**Fique de olho na linha `signed by`.** O token é um HMAC sobre os certificados de
assinatura, então ele só é o token que o servidor espera quando esses certificados
são os do próprio WhatsApp. Espelhos reassinam os APKs que hospedam, comumente com a chave
de teste do AOSP cuja metade privada vem no código-fonte do Android — um APK reassinado gera
um token que é bem formado e não pertence a ninguém. Qualquer coisa diferente de WhatsApp
nesse campo é sinalizada aqui como aviso, e o registro se recusa a
começar com ele, em vez de gastar solicitações de código do seu número em algo
que não pode dar certo. `WA_ALLOW_FOREIGN_APK=1` envia mesmo assim.

Só as partes derivadas são guardadas — o APK nunca mais é necessário. O registro
passa a pegar o arquivo sozinho daí em diante. `--out <file>` grava em outro lugar,
e `WA_ANDROID_APK_MATERIAL` aponta para ele se você o guardar em outro lugar.

**A versão também vem do APK.** Ela é lida do `AndroidManifest.xml` binário
e anunciada daí em diante, em vez da versão que a Play
Store lista no momento. O token é assinado sobre o `classes.dex` *desta* build, então
anunciar qualquer outra versão descreve uma build à qual o token não pertence.
`WA_VERSION` ainda sobrescreve tudo se você precisar; em um manifest sem
`versionName`, passe `--version <x.y.z.w>`.

**Atualize o material a cada novo lançamento do WhatsApp.** O `classes.dex` muda a cada lançamento e
o MD5 dele é assinado dentro do token, então material de uma build mais antiga deixa de bater com
a versão que está sendo anunciada. `wa apk-material --download` relê a build
atual; apagar o arquivo e registrar de novo faz a mesma coisa sozinho.

Programaticamente:

```js
const { extractMaterial, computeToken, materialToJson } = require('whalibmob/lib/AndroidApk')

const material = extractMaterial(
  fs.readFileSync('base.apk'),
  [{ name: 'split_config.xxhdpi.apk', data: fs.readFileSync('split_config.xxhdpi.apk') }]
)
fs.writeFileSync('android-apk-material.json', JSON.stringify(materialToJson(material)))
```

### Atestação de Dispositivo com Frida (opcional)

Os servidores de registro do WhatsApp pontuam cada requisição `/code` e `/register` pelo
quanto ela parece vir de um celular genuíno. Um dispositivo real se prova com um token de
atestação de hardware — **Play Integrity** mais uma requisição assinada pelo **Keystore** no
Android, **App Attest** no iOS. O whalibmob envia esses campos em toda requisição de registro,
mas só consegue preenchê-los com valores reais se conseguir falar com um dispositivo
de verdade.

Este repositório traz uma **pasta `frida/`** contendo os scripts que rodam no dispositivo e
produzem esses tokens. Ela é totalmente **opcional**: sem nenhum dispositivo conectado,
o whalibmob envia os mesmos campos de atestação vazios que um celular real envia quando sua
verificação de integridade falha, e o registro continua funcionando. Conectar um dispositivo eleva a
pontuação de confiança, o que ajuda quando você fica esbarrando em `no_routes` ou em telas de bloqueio.

> Requer um **celular Android com root** ou um **iPhone com jailbreak** com o app oficial do
> WhatsApp instalado a partir da Play Store / App Store. APKs instalados por sideload não
> funcionam — a atestação está vinculada à build assinada pela loja.

#### O que tem na pasta

```
frida/
  android/     Play Integrity + Keystore attestation server  (/integrity, /cert, /info)
  ios/         App Attest attestation server                 (/integrity)
```

Cada pasta de plataforma tem o seu próprio `README.md` com todos os pré-requisitos de dispositivo.

#### 1. Compile o script

Instale o [Frida](https://frida.re) no seu computador, depois compile o bundle para a sua
plataforma:

```bash
cd frida/android      # or: cd frida/ios
npm install
npm run build         # produces server_with_dependencies.js
```

#### 2. Rode-o no dispositivo

Certifique-se de que o servidor do Frida está rodando no celular, depois anexe-se ao WhatsApp:

```bash
# Android — open WhatsApp and reach the "register a number" screen FIRST,
# otherwise the integrity components are not loaded yet
frida -U "WhatsApp" -l server_with_dependencies.js

# iOS
frida -U -l server_with_dependencies.js -f "net.whatsapp.WhatsApp"
```

O script inicia um pequeno servidor HTTP **no celular**, escutando na porta `1119`
(ou `1120` se você se anexou ao WhatsApp Business). Espere por:

```
[*] Server ready on port 1119
```

#### 3. Torne a porta acessível

O whalibmob fala com aquele servidor por HTTP simples, então a porta precisa estar acessível
a partir da máquina que roda o seu bot. Por USB, encaminhe-a com o adb:

```bash
adb forward tcp:1119 tcp:1119     # Android
iproxy 1119 1119                  # iOS (libimobiledevice)
```

Como alternativa, se o celular estiver no mesmo Wi-Fi, use o IP da rede local dele diretamente.

#### 4. Aponte o whalibmob para ele

Defina o host — e a porta, se ela não for a padrão `1119`:

```bash
WA_FRIDA_HOST=127.0.0.1
WA_FRIDA_PORT=1119        # optional; use 1120 for WhatsApp Business
```

Ou no `.env`:

```
WA_FRIDA_HOST=127.0.0.1
WA_FRIDA_PORT=1119
```

Essa é a integração inteira. Na próxima chamada de `requestSmsCode()` / `verifyCode()`,
o whalibmob consulta o dispositivo automaticamente e anexa a atestação à
requisição:

| Plataforma | Campos que ela preenche                                            |
|----------|--------------------------------------------------------------------|
| Android  | `gpia` (Play Integrity) no corpo, mais uma assinatura do Keystore e a cadeia de certificados na requisição |
| iOS      | Uma assertion e uma attestation do App Attest na requisição          |

Mantenha a sessão do Frida aberta enquanto você registra. Quando você remove `WA_FRIDA_HOST`,
o whalibmob volta silenciosamente ao caminho de atestação vazia — sem mudanças de código, e
nada mais no seu bot é afetado.

> **Resolução de problemas.** Se os campos voltarem vazios, verifique nesta ordem: se a
> sessão do Frida continua anexada, se a porta está encaminhada e — no Android — se
> você abriu a tela de registro do WhatsApp pelo menos uma vez antes de anexar, já que
> os componentes de integridade são carregados sob demanda. O whalibmob nunca falha um registro
> por causa de atestação indisponível; ele simplesmente cai para valores vazios.

### Conectar

```js
const { WhalibmobClient } = require('whalibmob')
const path = require('path')

const client = new WhalibmobClient({
  sessionDir: path.join(process.env.HOME, '.waSession')
})

client.on('connected', () => {
  console.log('connected')
})

await client.init('919634847671')
```

#### Opções do Cliente

Toda opção é opcional; `sessionDir` é a única que a maioria dos remetentes chega a definir.

| Opção | Padrão | O que faz |
|---|---|---|
| `sessionDir` | `~/.waSession` | A pasta de autenticação. Cada número ganha a sua própria subpasta dentro dela — veja [Salvando e Restaurando Sessões](#salvando-e-restaurando-sessões). |
| `autoFixNumber` | `true` | Re-arquiva a sessão automaticamente quando o servidor reporta a conta sob um número diferente. Defina `false` para ser avisado em vez de corrigido — veja [O Número sob o Qual o WhatsApp Arquiva sua Conta](#o-número-sob-o-qual-o-whatsapp-arquiva-sua-conta). |
| `autoRead` | `true` | Envia recibos de leitura para as mensagens recebidas. `false` as deixa não lidas. |
| `refreshVersion` | `true` | Consulta a loja da plataforma pela build atual a cada conexão e reconexão, e a grava no arquivo de sessão. Tanto iOS quanto Android. Defina `false` para continuar anunciando aquilo com que a sessão foi registrada — veja [Mantendo a Versão Anunciada Atualizada](#mantendo-a-versão-anunciada-atualizada). |
| `pino` | desligado | Log de depuração. `true` liga no nível `debug`; um objeto é repassado ao `pino` como está. |
| `sentCacheSize` | `2000` | Quantas mensagens enviadas mantêm o seu texto puro para que um recibo de retry que as nomeie possa ser respondido. |
| `maxRetryResends` | `5` | Quantas vezes uma mensagem pode ser reenviada em resposta a recibos de retry antes de o cliente desistir. |
| `tcTokenPresendTimeoutMs` | `5000` | Quanto tempo a primeira mensagem para um novo contato espera pelo token de contato confiável antes de sair sem ele — veja [tcToken — Defesa contra o Erro 463](#tctoken--defesa-contra-o-erro-463). `0` envia imediatamente e deixa o token chegar para a próxima mensagem. |

```js
const client = new WhalibmobClient({
  sessionDir:      path.join(process.env.HOME, '.waSession'),
  sentCacheSize:   10000,
  maxRetryResends: 8
})
```

**Quando aumentar as duas últimas.** O aparelho de um destinatário que não consegue descriptografar uma mensagem pede a mensagem de novo, e o whalibmob responde reconstruindo a sessão Signal e reenviando. Responder exige o texto original, e é por isso que as mensagens enviadas são guardadas: um recibo que nomeia uma mensagem que não está mais no cache não pode ser respondido de jeito nenhum, e aquela mensagem — já confirmada pelo servidor — silenciosamente nunca chega.

Os padrões atendem um remetente comum. Aumente o `sentCacheSize` se você dispara mensagens mais rápido do que as respostas voltam, o que é fácil de acontecer quando vários destinatários estão sendo processados ao mesmo tempo: as suas próprias respostas envelhecem e saem do cache enquanto o destinatário ainda está pedindo por elas. O sintoma é esta linha no log de depuração:

```
[DBG] RETRY_RECV msgId=... — no cached plaintext, skipping resend
```

Se você a vir, o cache está menor que a sua janela de mensagens em trânsito. Uma entrada guarda a mensagem codificada, não a mídia para a qual ela aponta, então as entradas são pequenas e aumentar o limite custa pouca memória.

## Vinculando a uma Conta Existente (Código de Pareamento ou QR)

Registrar um número por SMS faz do whalibmob o **dispositivo próprio** daquele número. Às vezes não é isso que você quer — o número já está em uso em um celular, ou o SMS de verificação nunca chega. Para esses casos, o whalibmob pode em vez disso conectar por **WebSocket** e se vincular a uma conta que já existe, exatamente como os clientes WhatsApp Web e desktop fazem.

Existem duas formas de vincular, e as duas chegam ao mesmo lugar:

- **Código de pareamento** — o whalibmob te dá um código de 8 caracteres, o dono digita no celular dele.
- **QR code** — o whalibmob desenha um QR, o dono escaneia com a câmera do celular.

As duas vinculam o número como um dispositivo companion, e as duas deixam a biblioteca inteira funcionando igual depois — mesmo cliente, mesmos métodos, mesmos eventos. A única diferença é o que o dono faz: digitar um código, ou escanear um quadrado.

> [!IMPORTANT]
> Os dois modos são independentes. O registro por SMS continua inalterado e ainda é o padrão; nada nele é afetado pela vinculação. Um único número pode até ter uma sessão registrada e uma sessão vinculada — elas ficam em arquivos separados e nunca compartilham estado.

### Solicitando um Código de Pareamento

Conecte primeiro, depois peça o código: a requisição trafega pelo canal criptografado, então o canal precisa existir antes que possa haver um código.

```js
const { WhalibmobClient } = require('whalibmob')
const path = require('path')

const client = new WhalibmobClient({
  sessionDir: path.join(process.env.HOME, '.waSession')
})

client.on('paired', (p) => {
  console.log('linked as', p.jid)          // 919634847671:7@s.whatsapp.net
  console.log('lid      ', p.lid)          // 112713111982325:7@lid
  console.log('slot     ', p.deviceIndex)  // 7
})

client.on('connected', () => {
  console.log('ready')
})

// open the WebSocket connection as a companion
await client.connectWeb('919634847671', { syncFullHistory: true })

// ask for the code — returns immediately, the link completes later
const code = await client.requestPairingCode('919634847671')
console.log('enter this on the phone:', code)   // e.g. "K7M2QX4B"
```

No celular dono do número:

**WhatsApp → Configurações → Aparelhos conectados → Conectar um aparelho → Conectar com número de telefone**, então digite o código.

### Vinculando por QR Code

O caminho do QR é a alternativa de escanear-para-conectar. Você **não** solicita um código de pareamento — apenas conecta e escuta o evento `qr`. Como nenhum código é pedido, o servidor oferece um QR por conta própria, e o whalibmob o transforma em uma string pronta para renderizar:

```js
const { WhalibmobClient } = require('whalibmob')
const qrcode = require('qrcode-terminal')          // npm install qrcode-terminal
const path = require('path')

const client = new WhalibmobClient({
  sessionDir: path.join(process.env.HOME, '.waSession')
})

// a fresh QR string arrives here, and again each time the previous one expires
client.on('qr', ({ qr, remaining }) => {
  qrcode.generate(qr, { small: true })             // draw it in the terminal
  console.log('scan it — refreshes on its own,', remaining, 'left before it expires')
})

client.on('qr_timeout', () => console.log('QR set expired — reconnect for a fresh one'))

client.on('paired',    (p)  => console.log('scanned — linked as', p.jid))
client.on('connected', ()   => console.log('ready'))

// connect as a companion — and DO NOT request a pairing code
await client.connectWeb('919634847671', { syncFullHistory: true })
```

No celular dono do número:

**WhatsApp → Configurações → Aparelhos conectados → Conectar um aparelho**, então aponte a câmera para o QR.

A string `qr` é o que uma câmera do WhatsApp lê: `ref,noise,identity,advSecret,platformId` — um ref de uso único mais as chaves públicas deste cliente, unidos por vírgula, os mesmos campos que o próprio WhatsApp Web renderiza. Ela gira sozinha (cerca de um minuto para a primeira, depois menos) até a conta ser escaneada ou os refs acabarem. O `qrcode-terminal` é opcional — sem ele você recebe a string bruta no `qr` e pode renderizá-la como quiser (um PNG, uma página web, uma imagem em uma conversa). Para emitir o QR como um link `wa.me/settings/linked_devices#…` em vez dos campos puros, passe `{ qrWrapUrl: true }` para o `connectWeb`.

Tudo depois do escaneamento é idêntico ao caminho do código de pareamento: `paired`, um reinício do stream, e depois `connected`.

### Depois do Vínculo — Igual nos Dois Caminhos

Alguns segundos depois de o código ser aceito (ou o QR ser escaneado) você verá `paired`, o servidor reinicia o stream, e o `connected` dispara na nova conexão. A partir daí, todo o resto deste documento se aplica sem mudanças:

```js
await client.sendText('919876543210', 'sent from a linked device')
```

### Reconectando uma Sessão Vinculada

O vínculo é persistido. Em toda execução posterior, o `connectWeb()` sozinho basta — **não** peça um código novo:

```js
const client = new WhalibmobClient({ sessionDir })

client.on('connected', () => console.log('reconnected'))

await client.connectWeb('919634847671')
```

O `requestPairingCode()` lança um erro se a sessão já estiver vinculada, então é seguro se proteger com base nisso.

### Escolhendo seu Próprio Código

Se você preferir mostrar ao usuário um código escolhido por você, passe-o como segundo argumento. Ele precisa ter exatamente 8 caracteres:

```js
const code = await client.requestPairingCode('919634847671', 'MYCODE12')
```

### Opções

```js
await client.connectWeb(phone, {
  syncFullHistory: true,                       // ask the phone for full history (default true)
  browser: ['Ubuntu', 'Chrome', '120.0.0.0']   // what the owner sees in Linked Devices
})
```

`browser` é `[os, client, version]`. O segundo elemento decide o ícone de dispositivo mostrado no celular — `Chrome`, `Firefox`, `Safari`, `Edge`, `Opera`, `Desktop` são todos reconhecidos.

### Eventos Específicos do Vínculo

| Evento | Dispara quando |
|---|---|
| `pairing_code` | um código foi solicitado — `{ code, phoneNumber }` |
| `qr` | um QR está pronto para renderizar — `{ qr, ref, ttlMs, remaining }`; dispara de novo a cada rotação |
| `qr_timeout` | os refs do QR acabaram — reconecte para um conjunto novo |
| `paired` | o dono aceitou o código ou escaneou o QR — `{ jid, lid, deviceIndex, platform }` |
| `restart_required` | o servidor está reiniciando o stream depois do pareamento (normal; a reconexão é automática) |
| `pair_device` | as strings brutas de referência do QR, antes de virarem `qr` — `{ refs }` |
| `history_sync` | um pedaço do histórico chegou do celular |

### Obtendo o Histórico e a Agenda de Contatos

Esta é a parte que um número registrado nunca consegue fazer. Um dispositivo registrado por SMS **é** o principal da conta, e um principal não tem de quem receber histórico — ele começa com uma lista de contatos vazia e uma lista de conversas vazia, e só fica sabendo das pessoas que lhe mandam mensagem.

Um dispositivo vinculado é diferente: o celular da conta envia as conversas, os contatos e os nomes de exibição assim que o vínculo é estabelecido. O whalibmob descriptografa e armazena tudo isso automaticamente, e emite conforme vai chegando:

```js
client.on('history_sync', (r) => {
  console.log(r.syncTypeName)          // INITIAL_BOOTSTRAP, RECENT, FULL, PUSH_NAME
  console.log('chats   ', r.chats.length)
  console.log('contacts', r.contacts.length)

  for (const c of r.contacts.slice(0, 5)) {
    console.log(c.jid, c.name || c.notify)
  }
})

await client.connectWeb(phone, { syncFullHistory: true })
```

O histórico chega em pedaços ao longo do primeiro minuto após a vinculação, do maior para o menor. Tudo é mesclado em `<phone>.web.history.json` no seu diretório de sessão, então sobrevive a reinícios e você pode ler diretamente.

> [!NOTE]
> `syncFullHistory: false` pede apenas as mensagens recentes, o que vincula visivelmente mais rápido em contas com anos de histórico.

### Arquivos de Sessão

| Arquivo | Contém |
|---|---|
| `<phone>.web.json` | estado do vínculo — chaves, `advSecretKey`, o slot de dispositivo que você recebeu |
| `<phone>.web.signal.json` | sessões Signal, pre-key assinada, identidades, mapa de LID, contadores de pre-key |
| `<phone>.web.pre-key-<id>.json` | uma pre-key de uso único — 812 delas |
| `<phone>.web.sk.json` | SenderKeys de grupo |
| `<phone>.web.tctoken.json` | tokens de privacidade |
| `<phone>.web.appState.json` | versão e hash do app-state por coleção |
| `<phone>.appStateKeys.json` | chaves de sincronização do app-state compartilhadas pelo celular |
| `<phone>.web.history.json` | conversas, contatos, nomes de exibição e mapeamentos LID↔PN sincronizados |
| `<phone>.web.messages.json` | mapa simples de id de mensagem → metadados da mensagem |

O prefixo `.web.` mantém uma sessão vinculada completamente separada de uma registrada por SMS para o mesmo número.

### Mídia no Modo Companion

Uploads e downloads vão para os endpoints de CDN que o cliente web usa, não os do mobile. Isso é resolvido para você — `sendImage`, `sendVideo`, `sendSticker` e os demais recebem os mesmos argumentos nos dois modos — mas vale saber por que a distinção existe.

O cliente web não tem um endpoint por tipo de mídia. Uma figurinha é enviada ao endpoint de imagem e um GIF ao de vídeo; o que os torna figurinha ou GIF está na própria mensagem, não na URL. Enviar uma figurinha para `/mms/sticker` como companion resulta em 404. O CDN também espera um `Origin` de navegador tanto no upload quanto no download, e um user agent do WhatsApp mobile com um token de autenticação emitido pela web é uma incompatibilidade que ele pode recusar.

| Mídia | Endpoint do principal | Endpoint do companion |
|---|---|---|
| imagem | `/mms/image` | `/mms/image` |
| vídeo | `/mms/video` | `/mms/video` |
| áudio | `/mms/audio` | `/mms/audio` |
| documento | `/mms/document` | `/mms/document` |
| figurinha | `/mms/sticker` | `/mms/image` |
| gif | `/mms/gif` | `/mms/video` |
| mensagem de voz | `/mms/ptt` | `/mms/audio` |

O mesmo vale para os blobs de sincronização de histórico e as fotos de perfil.

### Identidade do Dispositivo

Toda mensagem enviada por um companion que abre uma nova sessão Signal carrega um nó `device-identity`: o registro assinado que o dispositivo principal da conta emitiu durante o pareamento, incluindo a chave de assinatura da conta. É assim que o cliente do destinatário sabe que uma mensagem vinda do dispositivo 7 de uma conta pertence genuinamente àquela conta, e não a alguém que apenas conhece o número.

O whalibmob anexa isso automaticamente sempre que há um `pkmsg` na stanza, tanto em mensagens diretas quanto em grupos. Um dispositivo registrado por SMS não tem esse registro — ninguém emitiu um para ele — e corretamente não envia nada.

### Como o Código Protege o Vínculo

O código de pareamento é uma senha, não um identificador. Ele nunca é enviado ao servidor às claras. Os dois lados o passam por PBKDF2-SHA256 (131.072 iterações) para derivar uma chave que envolve as chaves públicas efêmeras que eles trocam, e então combinam dois resultados Diffie-Hellman em `adv_secret` — a chave sob a qual toda prova posterior de pertencimento à conta é autenticada.

O whalibmob verifica três coisas antes de aceitar um vínculo, e o recusa de imediato se qualquer uma falhar: o HMAC sobre a identidade de dispositivo assinada, a assinatura da conta sobre a própria chave de identidade, e o slot de dispositivo que lhe foi atribuído. Um código errado não pode produzir um vínculo funcional, e uma resposta adulterada também não.

## Modo Companion — API Node.js

Tudo abaixo é a superfície completa para rodar o whalibmob como um dispositivo vinculado. Se você já usou a API do principal por SMS, nada aqui vai te surpreender: o cliente é a mesma classe, os métodos recebem os mesmos argumentos, e os eventos carregam os mesmos formatos. Só a forma de entrar é diferente.

### Exemplo Completo Funcional

Um bot que se vincula sozinho na primeira execução, reconecta silenciosamente em toda execução seguinte, e responde a mensagens.

```js
const { WhalibmobClient } = require('whalibmob')
const path = require('path')
const fs   = require('fs')

const PHONE    = '919634847671'                              // no '+', no spaces
const SESS_DIR = path.join(process.env.HOME, '.waSession')

// A session is already linked when this file exists and carries a device JID.
function isLinked() {
  const f = path.join(SESS_DIR, PHONE + '.web.json')
  if (!fs.existsSync(f)) return false
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'))
    return !!(j.registered && j.me && j.me.id)
  } catch { return false }
}

async function start() {
  const client = new WhalibmobClient({ sessionDir: SESS_DIR })

  client.on('pairing_code', ({ code }) => {
    console.log('\n  pairing code:', code.slice(0, 4) + '-' + code.slice(4))
    console.log('  phone → Settings → Linked Devices → Link a device')
    console.log('        → Link with phone number instead\n')
  })

  client.on('paired', ({ jid, lid, deviceIndex, platform }) => {
    console.log('linked as', jid, '· slot', deviceIndex, '· primary is', platform)
  })

  // The server restarts the stream right after pairing. This is normal and the
  // reconnect is automatic — there is nothing to do but log it.
  client.on('restart_required', () => console.log('restarting stream...'))

  client.on('connected', () => console.log('connected'))

  client.on('history_sync', (r) => {
    console.log(`history ${r.syncTypeName}: ${r.chats.length} chats, ${r.contacts.length} contacts`)
  })

  client.on('message', async (msg) => {
    const d = msg.decoded
    if (!d) return
    console.log(msg.from, d.type, d.text || '')

    if (d.type === 'text' && d.text === 'ping') {
      await client.sendText(msg.from, 'pong')
    }
  })

  client.on('error', (e) => console.error('error:', e.message))

  await client.connectWeb(PHONE, { syncFullHistory: true })

  if (!isLinked()) {
    await client.requestPairingCode(PHONE)
  }
}

start()
```

Rode uma vez, digite o código no celular, e ele estará vinculado. Rode de novo e ele conecta na hora.

### Métodos

| Método | Descrição |
|---|---|
| `client.connectWeb(phone, opts?)` | Abre a conexão companion. Resolve assim que o canal criptografado está de pé quando não vinculado, ou após o `<success>` quando já vinculado. |
| `client.requestPairingCode(phone?, customCode?)` | Pede um código de 8 caracteres. Retorna imediatamente; o vínculo se completa depois. Lança um erro se a sessão já estiver vinculada. |
| `client.disconnect()` | Fecha a conexão. O vínculo sobrevive — reconecte com `connectWeb()`. |

Opções do `connectWeb(phone, opts)`:

| Opção | Padrão | Descrição |
|---|---|---|
| `syncFullHistory` | `true` | Pede ao celular o arquivo completo. `false` solicita apenas as mensagens recentes e vincula visivelmente mais rápido. |
| `browser` | `['Ubuntu', 'Chrome', '120.0.0.0']` | `[os, client, version]`. O segundo elemento escolhe o ícone mostrado em Aparelhos conectados: `Chrome`, `Firefox`, `Safari`, `Edge`, `Opera`, `Desktop`. |
| `version` | buscada ao vivo | Revisão do cliente web a anunciar, ex.: `[2, 3000, 1035194821]`. Defina para fixar uma. |
| `fetchVersion` | `true` | Defina `false` para pular a consulta ao vivo e usar o fallback fixado. |

#### A Versão Anunciada

O endpoint web confere a revisão do cliente durante o handshake e recusa uma revisão desconhecida com `<failure reason="405">` — antes de qualquer stanza ser trocada, e sem nada na falha que diga que a versão era o problema. O endpoint mobile é bem mais tolerante; este não é.

Por isso o whalibmob lê a revisão ao vivo do próprio service worker do WhatsApp Web a cada `connectWeb()`, e cai para um valor fixado se essa consulta falhar. Você não deveria precisar pensar nisso, mas pode:

```js
const { fetchWaWebVersion } = require('whalibmob')

const { version, isLatest } = await fetchWaWebVersion()
console.log(version, isLatest)   // [2, 3000, 1035194821] true

// pin it yourself
await client.connectWeb(phone, { version: [2, 3000, 1035194821] })

// or skip the lookup entirely
await client.connectWeb(phone, { fetchVersion: false })
```

Se você algum dia vir `405`, é isso que significa. Não é uma sessão revogada e não há nada para reparear — reconecte para pegar a revisão atual.

`requestPairingCode(phone, customCode)`:

- `phone` — opcional; usa por padrão o número informado ao `connectWeb`.
- `customCode` — opcional; precisa ter **exatamente 8 caracteres** ou lança um erro. Use para exibir um código gerado por você.

### Eventos

Todo evento da API do principal por SMS dispara aqui também — `message`, `receipt`, `presence`, `group_update`, `call`, `blocklist`, `privacy_settings`, e os demais. Estes são os que só o modo companion produz:

| Evento | Payload | Dispara quando |
|---|---|---|
| `pairing_code` | `{ code, phoneNumber }` | um código foi solicitado |
| `paired` | `{ jid, lid, deviceIndex, platform }` | o dono aceitou o código |
| `restart_required` | `{ reason }` | o servidor está reiniciando o stream após o pareamento — a reconexão é automática |
| `pair_device` | `{ refs }` | o caminho do QR produziu strings de referência |
| `history_sync` | `{ syncTypeName, chats, contacts, pushNames, merged }` | um pedaço do histórico chegou |
| `history_sync_error` | `{ err, notification }` | um pedaço não pôde ser buscado ou descriptografado |
| `media_retry` | `{ messageId, chatJid, fromMe, participant, ciphertext, iv, error }` | o celular do remetente respondeu a um `requestMediaRetry()`. Leia com `decryptMediaRetry()` e a chave de mídia original; um `error` em vez de um payload significa que o celular também não tem mais o arquivo |
| `client_rejected` | `{ reason, location, message }` | o servidor recusou o cliente em si, não a sessão — `405` significa que a versão anunciada não é aceita. Dispara tanto se a recusa chega durante o handshake quanto depois que o stream está aberto, e o cliente para de tentar de qualquer forma. Diferente do `auth_failure`, e não há nada para reparear. |
| `version_update` | `{ from, to, source }` | a versão anunciada foi atualizada a partir da loja da plataforma antes de um handshake. Dispara em reconexões assim como na primeira conexão |
| `apk_material_stale` | `{ materialVersion, liveVersion, hint }` | somente Android: a listagem da Play Store avançou além do APK de onde veio o material de token em cache. Nada está quebrado — quem lê esse material é o registro — mas o próximo número registrado a partir desta instalação sairia sob uma build mais antiga |

### Lendo o que o Celular Enviou

```js
client.on('history_sync', (r) => {
  // r.syncTypeName — INITIAL_BOOTSTRAP | RECENT | FULL | PUSH_NAME | ...
  for (const chat of r.chats) {
    // { id, name, unreadCount, lastMsgTimestamp, messageCount }
    console.log(chat.id, chat.name, chat.unreadCount, chat.messageCount)
  }
  for (const contact of r.contacts) {
    // { id, name, username, pnJid, lidJid }
    console.log(contact.id, contact.name, contact.pnJid, contact.lidJid)
  }
  for (const p of r.pushNames || []) {
    console.log(p.id, p.pushname)
  }
})
```

Os pedaços chegam ao longo do primeiro minuto após a vinculação, do maior para o menor. Tudo é mesclado em `<phone>.web.history.json`, então você também pode ler direto do disco uma vez e dispensar o evento:

```js
const hist = JSON.parse(
  fs.readFileSync(path.join(SESS_DIR, PHONE + '.web.history.json'), 'utf8')
)
console.log(Object.keys(hist.chats || {}).length, 'chats on disk')
```

### Enviando

Idêntico ao modo principal — mesmos métodos, mesmos argumentos, mesmos formatos de retorno:

```js
await client.sendText(jid, 'hello')
await client.sendImage(jid, './photo.jpg', 'a caption')
await client.sendVideo(jid, './clip.mp4', 'watch this')
await client.sendAudio(jid, './voice.ogg', { ptt: true })
await client.sendDocument(jid, './report.pdf', 'report.pdf')
await client.sendSticker(jid, './sticker.webp')
await client.sendLocation(jid, 44.4268, 26.1025, 'Bucharest')
await client.sendContact(jid, 'Ana', vcard)
await client.sendPoll(jid, 'Lunch?', ['Pizza', 'Sushi'], 1)
await client.sendReaction(jid, msgId, '👍')
await client.sendStatus({ image: './photo.jpg', caption: 'hi' })
```

As assinaturas completas de cada um estão em [Enviando Mensagens](#enviando-mensagens) e [Mensagens de Mídia](#mensagens-de-mídia); nada nelas muda no modo companion.

Grupos, bloqueio, configurações de privacidade e alterações de perfil também funcionam da mesma forma.

> [!NOTE]
> Os uploads de mídia vão para os endpoints que o cliente web usa, que não são os mesmos do mobile para figurinhas, GIFs e mensagens de voz. O whalibmob troca automaticamente — veja [Mídia no Modo Companion](#mídia-no-modo-companion).

### Lidando com Reconexões

A biblioteca reconecta sozinha com backoff. O que você deve tratar é a diferença entre uma queda passageira e um vínculo revogado:

```js
client.on('disconnected',  ()      => console.log('dropped'))
client.on('reconnecting',  ({ delay }) => console.log('retry in', delay / 1000, 's'))
client.on('reconnected',   ()      => console.log('back'))

// The owner removed this device under Linked Devices. The session is dead —
// delete it and pair again.
client.on('auth_failure', ({ reason }) => {
  console.error('link revoked:', reason)
  fs.rmSync(path.join(SESS_DIR, PHONE + '.web.json'), { force: true })
  process.exit(1)
})
```

### Sabendo em Qual Modo Você Está

```js
console.log(client._mode)              // 'web' or 'mobile'
console.log(client.store.me.id)        // 919634847671:7@s.whatsapp.net
console.log(client.store.me.lid)       // 112713111982325:7@lid
console.log(client.store.deviceIndex)  // 7 — which linked-device slot
console.log(client.store.platform)     // 'android' — what the primary runs
```

O `deviceIndex` é o que faz de um companion um companion. Um principal é o dispositivo 0 e o JID dele é o número puro; um companion ocupa um slot numerado, e o próprio celular da conta se torna um par para o qual ele criptografa como para qualquer outro dispositivo.

### Duas Sessões em um Único Número

Um número pode estar registrado por SMS e, separadamente, vinculado como companion. Eles nunca compartilham estado — arquivos separados, sessões Signal separadas, histórico separado. Qual dos dois você obtém é decidido pelo método que você chama:

```js
await client.init(PHONE)        // mobile / primary, over TCP
await client.connectWeb(PHONE)  // web / companion, over WebSocket
```

Use duas instâncias de `WhalibmobClient` se quiser os dois ao mesmo tempo.

## O Número sob o Qual o WhatsApp Arquiva sua Conta

O WhatsApp nem sempre guarda uma conta sob o número que você digita. Os celulares brasileiros são o exemplo clássico: eles ganharam um nono dígito, e o WhatsApp mantém as contas mais antigas na forma de oito dígitos. `5596976042705` e `559676042705` são a mesma conta, mas só o segundo é o que o servidor reconhece.

Isso importa porque o número que está na sua sessão é enviado como nome de usuário em toda conexão. Erre a forma e o servidor não terá nenhum registro correspondente, então o login é recusado com `401` — um código que diz "desconectado" e não dá nenhuma pista de que o número era o problema.

O whalibmob resolve isso sozinho, nos dois sentidos:

**Quando você registra**, a forma canônica é lida da resposta do servidor e a sessão é salva sob ela. Números registrados pelo whalibmob não podem terminar nesse estado.

**Quando você conecta** uma sessão antiga que está nesse estado, o primeiro login é recusado, o whalibmob pergunta ao servidor qual forma ele usa, re-arquiva a sessão e conecta. Você vê uma linha:

```
connecting to +5596976042705...
  this account is registered as +559676042705 (not +5596976042705) — session updated
connected as +559676042705
```

A renomeação preserva o registro e as chaves Signal — ela move os arquivos da sessão, não registra nada de novo.

```js
client.on('number_corrected', ({ from, to }) => {
  console.log('session re-filed:', from, '→', to)
})
```

Para ser avisado em vez de corrigido:

```js
const client = new WhalibmobClient({ sessionDir, autoFixNumber: false })
```

Assim o `401` é lançado como está, e o `checkSessionAlive()` te diz como o servidor chama a conta:

```js
const probe = await client.checkSessionAlive()
// { alive: true, status: 'ok', current: '5596976042705',
//   canonical: '559676042705', mismatch: true }

if (probe.mismatch) {
  await client.adoptCanonicalNumber(probe.canonical)
}
```

> [!NOTE]
> A verificação não custa nada quando tudo funciona — ela só roda depois que um login já foi recusado.

## Quando o Registro É Recusado por Falta de Consentimento

Alguns números voltam do `/register` assim:

```json
{ "login": "557176034186", "pending": "app_store_age", "reason": "consent", "status": "fail" }
```

O código não foi recusado e a conta foi encontrada — o WhatsApp está pedindo um sinal de idade que só uma instalação real vinda da loja de apps carrega, e não vai concluir sem ele. Os números brasileiros são onde isso aparece na prática.

A primeira coisa a tentar é o perfil de dispositivo Android. A requisição de registro do iOS carrega seis campos e nenhum deles diz nada sobre consentimento, termos ou idade; a do Android carrega `tos_version`, `education_screen_displayed` e `clicked_education_link`.

```sh
WA_OS=android wa registration --code 5571976034186
```

Se isso também for recusado, o número precisa passar pelo app real uma vez, em um celular, antes de poder ser registrado aqui.

> [!NOTE]
> O campo `login` naquela resposta vale ser lido. Os celulares brasileiros ganharam um nono dígito que o WhatsApp nunca adotou, então `+5571976034186` é arquivado como `+557176034186`. O whalibmob adota a forma do servidor automaticamente em um registro bem-sucedido e salva a sessão sob ela — a diferença de dígito não é, em si, a falha.

## O Push Token

Todo WhatsApp em um celular real tem um push token. Ele é o endereço que a rede de push usa para acordar o app, e nenhuma instalação existe sem um — então um registro que não envia `push_token` descreve um WhatsApp que não pode ser notificado, ou seja, um dispositivo que não existe.

**Este é um recurso do perfil Android.** Qual rede de push uma instalação usa decorre da plataforma dela: o Android tem um token do *Firebase* e mantém um stream aberto com o Google, o iOS tem um token do *APNs* e mantém um aberto com a Apple. Eles não são intercambiáveis, e o servidor de registro vê tanto o token quanto o User-Agent nomeando a plataforma que o enviou — um iPhone apresentando um token do Firebase descreve um dispositivo que ninguém fabrica. Só o lado do Firebase está implementado aqui, então tudo nesta seção se aplica quando `WA_OS=android`. Um registro iOS não envia nenhum `push_token`, o que é o correto para um cliente sem linha de push, e todo o resto do fluxo não é afetado.

O token faz dois trabalhos distintos, e é fácil confundi-los:

1. **Ele faz o registro parecer real — sempre.** Toda requisição `/code` agora carrega o token, qualquer que seja o método de entrega que você peça. O servidor vê uma instalação que pode ser alcançada, não um cliente headless. Esta é a razão pela qual o token importa, e vale para `sms`, `voice`, `wa_old` — todos eles.
2. **Ele pode carregar o próprio código — às vezes.** Como você entregou ao WhatsApp uma linha direta, o WhatsApp *pode* também enviar o código de seis dígitos silenciosamente por ela, de modo que o app preencha o código sozinho. É por isso que o código se autocompleta em um celular real antes de você ter lido o SMS. Isso acontece *junto* com o método que você escolheu, não no lugar dele.

O método de entrega e o push não são alternativas. Você continua escolhendo como um humano recebe o código (`sms`, `voice`, `wa_old`); o push, quando vem, é uma segunda cópia silenciosa desse mesmo código enviada direto para o app.

```
request a code ─┬─ method you chose  →  reaches a human   (SMS, a call, the existing WhatsApp)
                └─ push_token line   →  reaches the app    (silent, auto-filled — if WhatsApp sends it)
```

O registro busca um token real e o envia, em três chamadas HTTPS simples ao Google:

| Passo | Endpoint | Produz |
|---|---|---|
| 1 | `android.clients.google.com/checkin` | um android id e um token de segurança — a identidade do dispositivo junto ao Google |
| 2 | `firebaseinstallations.googleapis.com` | uma instalação Firebase para o projeto do WhatsApp |
| 3 | `android.clients.google.com/c2dm/register3` | o próprio token FCM |

Sem root, sem Frida, sem celular. Isso não tem relação com a atestação do Play Integrity — as duas coisas viajam na mesma requisição, mas vêm de lugares diferentes, e uma funciona sem a outra.

Isso roda uma vez por número. A identidade do Firebase fica em cache na sessão, porque o Google emite um android id uma vez e espera recebê-lo de volta; buscar um novo a cada passo do registro criaria um dispositivo fantasma novo a cada vez.

**A falha é silenciosa por design.** Uma rede bloqueada, uma recusa do Google, uma resposta malformada — tudo termina com o campo omitido e o registro seguindo exatamente como seguia antes de os push tokens existirem aqui. Um push token ajuda; ele nunca é um pré-requisito.

Desligue com `WA_FCM_PUSH=0`.

### Recebendo o Código por Push (sem digitá-lo)

Esta é a ponta receptora do trabalho 2 acima. Quando o WhatsApp envia o código como um push silencioso, algo precisa estar escutando na linha do Firebase para capturá-lo — a mesma conexão de longa duração que todo celular Android mantém aberta com o Google. O `receivePushCode(store, device)` a abre: um stream TLS para `mtalk.google.com:5228` falando o protocolo MCS, autenticado com a identidade do Firebase, resolvendo com o código no momento em que um push que o carrega chega.

Assim como o token em si, isso é somente Android. Em um perfil iOS o `receivePushCode` resolve `null` imediatamente, em vez de manter um listener aberto em uma linha que nenhum push alcança, e o `/reg push` avisa e para em vez de esperar o timeout. Verifique com `supportsPush(store.device)` se quiser ramificar seu código com base nisso.

A ordem importa. Abra o listener **primeiro**, para que a linha esteja ativa antes de o código ser solicitado; depois solicite o código por qualquer método; depois aguarde por ele.

```js
const { receivePushCode, requestSmsCode, verifyCode } = require('whalibmob')

// 1. open the listener first, so the push has somewhere to land
const codePromise = receivePushCode(store, store.device, { timeoutMs: 180000 })

// 2. request the code — any method. The push, if it comes, is a copy of it.
await requestSmsCode(store, 'sms')          // or 'voice', 'wa_old', …

// 3. if the push arrives, the code is here with nothing typed
const code = await codePromise
if (code) await verifyCode(store, code)
else      { /* no push — read the code from SMS / the existing WhatsApp, then verifyCode */ }
```

Pela CLI a sequência inteira é um comando:

```
/reg push <phone> [sms|voice]
```

Ele abre o listener, espera até estar autenticado, solicita o código e confirma automaticamente se o push chegar — caindo para `/reg confirm <phone> <code>` quando não chega.

A conexão carrega um heartbeat e lembra os ids de mensagem que já viu, então uma reconexão não relê um código já entregue, do jeito que o cliente nativo faz. Ela resolve `null` em timeout, login recusado ou qualquer falha — momento em que você simplesmente lê o código do jeito comum e o verifica. Como o token, ela também passa pelo proxy SOCKS configurado.

> [!IMPORTANT]
> Receber o push não é a mesma coisa que fazer o WhatsApp enviá-lo. Se o WhatsApp envia ou não o código por push em uma dada requisição é decisão do servidor, e em um cliente que envia atestação vazia ele frequentemente manda o código apenas pelo método que você pediu (SMS, `wa_old`, uma chamada) e nenhum push silencioso. Este listener captura o push corretamente **quando um é enviado**; ele não pode forçar esse canal, e nunca substitui o método escolhido — ele roda ao lado dele. Com uma atestação válida do Play Integrity na requisição (`WA_FRIDA_HOST`), é mais provável que o servidor inclua o push silencioso.

## Roteando o Tráfego por um Proxy

Duas razões para querer isso. O registro é a parte do protocolo com maior chance de ser recusada a partir de um IP de datacenter, então uma saída residencial ajuda com bloqueios de segurança e status de número indetermináveis. E em uma rede que não alcança o WhatsApp de jeito nenhum, nada funciona sem proxy.

Instale a dependência opcional e defina uma variável de ambiente:

```sh
npm install socks
```

```sh
# Tor
export TOR_PROXY=socks5://127.0.0.1:9050

# a residential proxy that needs credentials
export SOCKS_PROXY=socks5://user:pass@proxy.example.com:1080
```

Um `host:port` puro é presumido como SOCKS5, então `TOR_PROXY=127.0.0.1:9050` também funciona. `socks5`, `socks5h`, `socks4` e `socks4a` são todos aceitos, e o `TOR_PROXY` vence se as duas variáveis estiverem definidas.

Se a senha contiver `@` ou `:`, faça o percent-encoding — `p@ss:word` vira `p%40ss%3Aword`. O whalibmob decodifica antes de entregar ao proxy.

```js
// or from code, before you call any registration function
process.env.SOCKS_PROXY = 'socks5://user:pass@proxy.example.com:1080'

await requestSmsCode(phone, store)
```

### O que Passa por Ele

Tudo o que a biblioteca envia para fora:

| Conexão | Destino |
|---|---|
| Socket de mensagens, mobile | TCP puro para o WhatsApp |
| Socket de mensagens, web | `wss://web.whatsapp.com/ws/chat` |
| Registro | `v.whatsapp.net` |
| Versão anunciada, iOS | consulta na App Store |
| Versão anunciada, Android | listagem da Play Store |
| Versão anunciada, web | `web.whatsapp.com/sw.js` |
| Material do APK para registro | download da Play Store |
| Upload de mídia | hosts de mídia do WhatsApp |

Os módulos `http`/`https` do Node ignoram completamente as variáveis de ambiente de proxy — um proxy tem que ser entregue como agent, em cada ponto de chamada. Só o POST do registro fazia isso, o que produzia uma falha confusa: `curl -x socks5://…` chegava ao WhatsApp enquanto a biblioteca dava timeout na mesma máquina, caindo para uma versão fixada com apenas uma linha de debug para mostrar:

```
[DBG] WEB_VERSION 2.3000.1035194821 (pinned fallback: sw.js fetch timed out)
```

Agora todos os oito caminhos compartilham um único agent.

Se o `socks` não estiver instalado, ou um proxy estiver inacessível, você recebe uma mensagem dizendo isso em vez de uma falha silenciosa. Uma URL de proxy que não pode ser interpretada deixa a conexão direta em vez de lançar erro — uma consulta de versão com fallback fixado não deveria derrubar um processo por causa do proxy. No caso raro de o pacote estar em um lugar onde o `require()` não o encontra, o `WA_SOCKS_LIB` recebe um caminho absoluto até ele.

## Salvando e Restaurando Sessões

As sessões são persistidas em disco dentro do `sessionDir` que você fornece — a
pasta de autenticação. Passe qualquer caminho que quiser; nada é fixo no código.

```js
const client = new WhalibmobClient({
  sessionDir: path.join(process.env.HOME, 'whalibmob_auth')
})

// no need to register again — just connect
await client.init('919634847671')
```

**Cada número ganha uma pasta própria lá dentro**, contendo todo arquivo que
aquele número possui:

```
whalibmob_auth/
├── android-apk-material.json            ← shared by every Android registration
├── android-apk-material-business.json
├── 919634847671/
│   ├── 919634847671.json                ← the store: keys, device, version
│   ├── 919634847671.signal.json         ← Signal sessions, signed pre-key, identities
│   ├── 919634847671.pre-key-1.json      ← one-time pre-keys, one file each
│   ├── 919634847671.pre-key-2.json
│   ├── …                                  812 of them
│   ├── 919634847671.pre-key-812.json
│   ├── 919634847671.sk.json             ← sender keys
│   ├── 919634847671.tctoken.json
│   ├── 919634847671.device-cache.json
│   ├── 919634847671.lid-mapping.json
│   ├── 919634847671.lid-reverse-mapping.json
│   ├── 919634847671.appState.json
│   ├── 919634847671.appStateKeys.json
│   ├── 919634847671.history.json
│   └── 919634847671.messages.json
└── 5568936182750/
    └── …
```

Um vínculo companion para o mesmo número fica ao lado como `<phone>.web.json` e
companhia, na mesma pasta.

Uma conta passa a ser um diretório: copie-o para mover um número para outra máquina,
apague-o para se livrar de um, arquive-o para guardar. Nada precisa ser garimpado
de uma pilha por prefixo.

> [!NOTE]
> **As sessões escritas por versões anteriores continuam funcionando onde estão.** O
> layout é decidido por número: um número cujos arquivos estão soltos no diretório
> base é deixado exatamente como está, e só números novos ganham uma pasta. Nada
> é movido a menos que você peça — o `wa migrate-sessions` faz isso, para um número ou para
> todos eles, e rodá-lo de novo é seguro.

### Mantendo a Versão Anunciada Atualizada

Toda conexão anuncia a build do WhatsApp que ela alega ser. O servidor confere
isso, e quando ele deixa de reconhecer o número, recusa o handshake com
`405` — uma falha que não diz nada sobre a versão e não tem nada a ver com
a conta.

Uma sessão registra a versão com a qual foi registrada. Deixada por conta própria, ela anuncia esse
mesmo número para sempre, então um número registrado na primavera ainda está alegando ser uma build
de primavera no outono, e um dia a conexão simplesmente para de funcionar.

**As sessões se atualizam sozinhas, nas duas plataformas.** Antes de cada handshake o
cliente pergunta à loja da plataforma qual é a build atual e a grava em
`<phone>.json`. O iOS lê a listagem da App Store, o Android a da Play Store.
Nada para rodar, nada para lembrar:

```js
client.on('version_update', ({ from, to, source }) => {
  console.log('announcing', to, 'instead of', from, '—', source)
})

await client.init('40756469325')
```

**As reconexões também estão cobertas.** A verificação roda a partir do passo de conexão do socket
em vez de a partir do `init()`, então o próprio laço de reconexão da biblioteca também passa por ela.
Um bot que fica de pé por semanas não sai anunciando eternamente o que a
listagem dizia na manhã em que ele começou. O handshake lê a versão da
loja no momento em que roda, então uma versão gravada aqui é a que sai.

Quatro regras impedem que isso seja o que quebra uma sessão funcional:

- **Ela nunca anda para trás.** As duas consultas respondem com um fallback fixado em vez de
  falhar quando não conseguem alcançar a rede, e esse fallback pode facilmente
  ser mais antigo do que o que a sessão tem. Levar uma sessão para uma versão mais antiga é
  o único resultado que torna um `405` *mais* provável.
- **`WA_VERSION` ainda vence.** Uma versão fixada na saída de um `405` é uma
  decisão, e nunca é substituída silenciosamente.
- **Uma consulta que falha não muda nada.** A sessão mantém a versão que tem e
  a conexão segue.
- **A rede não é consultada duas vezes pela mesma resposta.** Cada consulta é
  memoizada por seis horas, então uma conexão que oscila a cada poucos segundos chega
  à loja uma vez em vez de uma vez por tentativa — e uma sessão de pé por um mês
  ainda pega um lançamento no dia em que ele sai.

Defina `{ refreshVersion: false }` no cliente para desligar isso.

> [!NOTE]
> **O registro continua lendo o APK.** Um número sendo registrado anuncia o
> `versionName` do APK de onde veio o seu material de token, porque o token de
> registro Android é assinado sobre aquela build. Só a versão *anunciada* em
> uma sessão já registrada segue a listagem da Play Store — nenhum token
> viaja no handshake, então não há nada ali para ficar fora de sincronia.
> Quando a listagem passa do material em cache, o cliente emite
> `apk_material_stale`, que é a deixa para rodar `wa apk-material --download`
> antes de registrar o próximo número.

A ferramenta manual continua funcionando nas duas plataformas:

```bash
wa refresh-version 40756469325                    # current build for the platform
wa refresh-version 40756469325 --version 2.25.1.2 # or one you name
```

As sessões companion nunca tiveram esse problema: o `connectWeb()` já lê a
revisão web ao vivo a cada conexão.

### Pré-chaves de Uso Único

Uma pre-key é uma chave Diffie-Hellman de uso único que a conta deixa com o servidor para que
alguém que queira mandar mensagem consiga abrir uma sessão Signal sem que a conta esteja
online. Cada uma é entregue uma vez e depois some. Se acabarem, ninguém consegue iniciar
uma conversa com o número de jeito nenhum — as mensagens não ficam atrasadas, elas
nunca são enviadas, e nada em lugar nenhum reporta isso.

O whalibmob mantém um pool de **812**, geradas no momento em que uma sessão é criada e
gravadas uma chave por arquivo, na pasta de autenticação que você informou:

```
~/.waSession/919634847671/
├── 919634847671.pre-key-1.json
├── 919634847671.pre-key-2.json
└── … 919634847671.pre-key-812.json
```

Um vínculo companion para o mesmo número mantém o próprio pool ao lado, como
`919634847671.web.pre-key-<id>.json`. Os dois nunca são compartilhados: são
dispositivos separados com chaves de identidade separadas, e uma chave oferecida sob a
identidade errada não pode ser respondida.

O arquivo tem o mesmo formato que o cliente de referência grava — a chave pública bruta
de 32 bytes e a chave privada, ambas em BufferJSON:

```json
{"private":{"type":"Buffer","data":"…"},"public":{"type":"Buffer","data":"…"}}
```

**Mantendo o servidor abastecido.** Três coisas disparam isso, e todas perguntam ao
servidor o que ele realmente tem, em vez de adivinhar pelo pool local —
os dois se afastam, porque o servidor gasta uma chave a cada bundle que
entrega e nada disso chega até este lado.

| Quando | O que faz |
|---|---|
| no login | pergunta a contagem ao servidor; **0** ali significa que as 812 completas sobem, qualquer valor baixo significa uma reposição de 5 |
| quando o servidor avisa que está acabando | mesma verificação, mesmo lote |
| a cada 30 minutos | mesma verificação — para a sessão que fica de pé tempo suficiente para ser drenada sem aviso |

Um lote são os próximos ids que ainda não foram enviados ao servidor, nunca o pool inteiro
de novo, e só conta como enviado depois que o servidor confirmou — um upload
recusado é repetido quatro vezes com backoff e depois deixado para a próxima verificação, com
as mesmas chaves ainda na fila. Os ids nunca são reutilizados, mesmo depois de a chave sob um
deles ter sido gasta.

Depois do upload no login, a conta também pede o **digest do key bundle** do servidor
e compara a chave de identidade e a pre-key assinada que estão sendo servidas
com as que esta sessão tem. Uma divergência ali é a falha que antes
exigia registrar o número de novo para resolver.

Nada disso precisa ser chamado: `init()` e `connectWeb()` fazem tudo, de forma idêntica.

> [!NOTE]
> **As sessões escritas antes da 5.14.19 mantêm todas as chaves que tinham.** As pre-keys
> ficavam dentro de `<phone>.signal.json`; na primeira inicialização elas são movidas para
> arquivos próprios e a cópia agregada é descartada. As chaves em si não
> mudam, então os bundles que o servidor já entregou continuam respondíveis.

### De Onde Vem a Pasta

| ordem | origem |
|---|---|
| 1 | `sessionDir` passado ao `WhalibmobClient` (biblioteca), ou `--session <dir>` (CLI) |
| 2 | `WA_SESSION_DIR` no ambiente |
| 3 | a resposta lembrada em `~/.whalibmob.json`, que a CLI pergunta uma vez na primeira execução |
| 4 | `~/.waSession` |

A CLI só pergunta quando nenhuma das opções acima decidiu e a pasta padrão
está vazia, então uma instalação existente nunca é solicitada a renomear nada, e uma
execução não interativa — um script, um cron — nunca trava na pergunta.

```
  where should sessions be kept? each number gets its own folder inside.
  a bare name goes under your home directory; enter for /home/you/.waSession
  authentication folder:  whalibmob_auth
  sessions will be kept in /home/you/whalibmob_auth
```

Um nome simples é criado dentro do seu diretório home; um caminho absoluto ou um que
começa com `~` é usado como foi dado.

### Descobrindo os Caminhos por Conta Própria

`lib/SessionPaths` é o mesmo resolvedor que a biblioteca e a CLI usam, então quem
quiser ler ou mover os arquivos de uma sessão não precisa adivinhar o
layout:

```js
// exported from the package itself, or from lib/SessionPaths directly
const {
  defaultBaseDir, sessionDirFor, storeFileFor, webStoreFileFor,
  listSessions, migrateSession, SessionPaths
} = require('whalibmob')

const { isLegacyLayout, SESSION_SUFFIXES } = SessionPaths

const base = path.join(process.env.HOME, 'whalibmob_auth')

sessionDirFor(base, '919634847671')                  // …/whalibmob_auth/919634847671
sessionDirFor(base, '919634847671', { create: true }) // and makes it
storeFileFor(base, '919634847671')                   // …/919634847671/919634847671.json
webStoreFileFor(base, '919634847671')                // …/919634847671/919634847671.web.json

listSessions(base)
// [ { phone, dir, storeFile, webStoreFile, legacy, hasMobile, hasWeb }, … ]
//   covers both layouts, so it is what to iterate over

migrateSession(base, '919634847671')
// { phone, from, to, moved: [...], skipped: [...] }   moves one number into its folder
```

`SESSION_SUFFIXES` é todo arquivo por número que a biblioteca grava — a lista contra a qual
copiar ou apagar se você estiver movendo uma conta manualmente.

## Utilitários do Signal Store

O `auth-utils` é uma coleção de helpers opcionais para usuários avançados que gerenciam suas próprias instâncias de `SignalStore` diretamente (ex.: backends de armazenamento personalizados, servidores multi-conta).

```js
const {
  makeCacheableSignalKeyStore,
  addTransactionCapability,
  assertMeId,
  initAuthCreds
} = require('whalibmob')
```

### `makeCacheableSignalKeyStore`

Envolve um `SignalStore` com um cache em memória (TTL de 5 minutos). As leituras de sessões, pre-keys, pre-keys assinadas e chaves de identidade são servidas do cache nos acessos seguintes; as chamadas `store*` escrevem nos dois, e as chamadas `remove*` / `delete*` descartam a entrada.

Uma consulta que não encontra nada **não** é cacheada. A ausência é o estado com maior chance de mudar por baixo dos panos — uma sessão prestes a ser construída, uma pre-key prestes a ser enviada — então um "não encontrado" lembrado é justamente o que causaria problema.

`useClones` é definido como `false` para que os objetos `SessionRecord` — que carregam estado interno e métodos — sejam retornados por referência e nunca clonados profundamente.

Todo método que o store subjacente tem é repassado, incluindo `transaction()` e `isInTransaction()` quando presentes, então o wrapper é um substituto direto e é seguro empilhá-lo com o `addTransactionCapability`.

```js
const { SignalStore, makeCacheableSignalKeyStore } = require('whalibmob')

const store  = new SignalStore()
const cached = makeCacheableSignalKeyStore(store)

// reads hit cache after first access
const session = await cached.loadSession('919634847671.0')
```

Chame `await cached.flushCache()` para descartar tudo — depois de uma rotação de chaves, ou quando outro processo pode ter escrito no mesmo arquivo de sessão.

**Quando usar:** sempre que o seu `SignalStore` for apoiado por um armazenamento remoto ou em disco (banco de dados, Redis, sistema de arquivos) e você quiser reduzir consultas repetidas para sessões que não mudaram entre os envios.

### `addTransactionCapability`

Envolve um `SignalStore` com semântica de escrita em lote (transação). Durante uma transação, todas as escritas são armazenadas em memória e descarregadas no store subjacente de uma vez quando o callback retorna — não há `commit()` para chamar. As leituras conferem o buffer primeiro, então uma transação enxerga as próprias escritas. Se o callback lançar erro, nada é escrito e o erro chega até quem chamou.

Usa `AsyncLocalStorage` para propagar o contexto da transação por cadeias de chamadas assíncronas, e um `Mutex` com contagem de referências por chave de transação.

```js
const { SignalStore, addTransactionCapability, makeCacheableSignalKeyStore } = require('whalibmob')

// recommended: cache first, then transactions on top
const base     = new SignalStore()
const cached   = makeCacheableSignalKeyStore(base)
const txnStore = addTransactionCapability(cached)

// inside a send flow
await txnStore.transaction(async () => {
  // all writes are buffered until this callback returns
  await txnStore.storeSession('919634847671.0', sessionRecord)
  await txnStore.storePreKey(1, preKeyPair)
}, 'send')
```

O segundo argumento é um escopo: duas transações com chaves diferentes rodam simultaneamente, duas com a mesma chave rodam uma após a outra. O padrão é `'default'`. Qualquer chave é segura — os locks de transação são mantidos separados dos locks que as leituras tomam, então nenhuma escolha de chave pode fazer uma transação esperar por si mesma.

Chamadas aninhadas de `transaction()` reutilizam o contexto que as envolve em vez de abrir um segundo, então uma transação interna não faz commit por conta própria.

A ordem de empilhamento importa: coloque o `makeCacheableSignalKeyStore` abaixo do `addTransactionCapability`, para que uma transação revertida nunca chegue ao cache. A outra ordem também funciona — uma transação que falha limpa o cache em vez de deixá-lo segurando escritas que o store nunca aceitou — mas ela joga fora entradas boas para fazer isso.

**Quando usar:** para servidores de alto volume que enviam para muitos destinatários simultaneamente e precisam agrupar as escritas de chaves Signal em um único flush atômico por mensagem.

### `assertMeId`

Retorna o JID da conta, ou lança um `Error` descrevendo o que está faltando.

Funciona com os dois tipos de store — o store de SMS de `initAuthCreds` / `createNewStore`, e o store companion de `createNewWebStore`. Só o texto do erro difere, já que a saída de "ainda não registrado" é a verificação por SMS em um caso e o pareamento no outro.

Uma vez registrado, o JID que o servidor atribuiu é o preferido (`store.me.id`) — em um companion ele carrega o sufixo de dispositivo, e reconstruí-lo a partir do número de telefone descarta isso silenciosamente. Antes do registro ele lança erro, inclusive durante a janela de pareamento: solicitar um código de pareamento grava um `me` provisório sem sufixo, e isso não é tratado como estar vinculado.

```js
const { assertMeId } = require('whalibmob')

const store = loadStore(sessFile)

try {
  const jid = assertMeId(store)
  // '919634847671:12@s.whatsapp.net' once connected,
  // '919634847671@s.whatsapp.net' before that
  console.log('account JID:', jid)
} catch (err) {
  console.error('store is not registered:', err.message)
}
```

**Quando usar:** como proteção antes de chamar `client.init()`, para dar uma mensagem de erro clara quando um arquivo de sessão corrompido ou não registrado é carregado por engano.

### `initAuthCreds`

Cria um store de credenciais novo para o número de telefone informado — os pares de chaves, o registration ID e os identificadores de dispositivo que um número precisa antes de sequer poder pedir um código SMS. É o que o `/reg code` chama.

Ele retorna tudo o que o `createNewStore` retorna, mais alguns campos mantidos para código de aplicação que os espera: `nextPreKeyId`, `firstUnuploadedPreKeyId`, `accountSyncCounter`, `accountSettings`, `processedHistoryMessages` e `advSecretKey`. Esses extras existem somente no objeto — o `saveStore` não os grava, então eles não estão lá depois de um recarregamento. Nada na biblioteca os lê; trate-os como conveniência, não como estado.

> [!NOTE]
> Os dois contadores de pre-key com os quais a biblioteca realmente funciona são os do
> `SignalStore` — `nextPreKeyId()` e `firstUnuploadedPreKeyId()`, persistidos em
> `<phone>.signal.json`. Eles ficam lá em vez de no store porque a metade mobile de um
> número e a metade companion têm um `SignalStore` cada e nunca podem
> compartilhar um espaço de ids de pre-key. Os campos acima são os mesmos nomes em um
> objeto diferente e não controlam nada.

```js
const { initAuthCreds, saveStore } = require('whalibmob')
const path = require('path')
const fs   = require('fs')

const phone    = '919634847671'
const sessDir  = path.join(process.env.HOME, '.waSession')
const sessFile = path.join(sessDir, phone + '.json')

fs.mkdirSync(sessDir, { recursive: true })

const store = initAuthCreds(phone)
saveStore(store, sessFile)
```

Esta é a função que a CLI usa para toda nova sessão por SMS. Prefira-a ao `createNewStore` por compatibilidade futura.

> [!NOTE]
> `initAuthCreds` e `createNewStore` produzem stores equivalentes para toda operação atual da biblioteca, e arquivos idênticos em disco. Use `createNewWebStore` quando o dispositivo for vinculado como companion em vez de registrado por SMS — esse adiciona os campos de pareamento, e o serializador dele os persiste.

O arquivo que ele grava tem exatamente estas 16 chaves:

```json
{
  "phoneNumber": "40712345678",
  "noiseKeyPair":    { "private": "…", "public": "…" },
  "identityKeyPair": { "private": "…", "public": "…" },
  "signedPreKey":    { "id": 3649616, "private": "…", "public": "…", "signature": "…" },
  "registrationId": 2183,
  "fdid": "2f701f8b-d693-4728-…",
  "deviceId": "CBIyyJRAokOdYoTYEjTbng==",
  "identityId": "SE8Q785oful7dGdBgNpwjg==",
  "advertisingId": "5c97eea9-783f-4fcc-…",
  "backupToken": "…",
  "registered": true,
  "codePending": false,
  "name": "Boss",
  "version": "2.26.9.75",
  "device": { "os": "ios", "platform": 1, "model": "iPhone 15 Pro", "…": "…" },
  "advIdentity": "…"
}
```

`registered` e `codePending` são os dois que se movem: ambos `false` quando o store é criado, o `codePending` vira `true` assim que um código é solicitado, e o `verifyCode` define `registered` como `true` e `codePending` de volta para `false`. O `advIdentity` fica `null` até o servidor enviar a identidade de dispositivo assinada no `<success>`.

### Padrão Recomendado de Empilhamento

Para um servidor multi-conta em produção:

```js
const {
  SignalStore,
  makeCacheableSignalKeyStore,
  addTransactionCapability,
  initAuthCreds,
  saveStore,
  loadStore
} = require('whalibmob')

// 1. load or create the credential store
let store = loadStore(sessFile) || initAuthCreds(phone)

// 2. build the layered Signal key store
const signalStore = new SignalStore()
signalStore.attachFile(sessFile)
const cachedStore = makeCacheableSignalKeyStore(signalStore)
const txnStore    = addTransactionCapability(cachedStore)

// 3. pass to the client (advanced usage — most users should use WhalibmobClient directly)
```

Para o uso comum, o `WhalibmobClient` cuida de tudo isso internamente. Estes helpers são para cenários avançados em que você precisa de controle direto sobre o armazenamento das chaves Signal.

## Tratando Eventos

O whalibmob usa a sintaxe do EventEmitter para eventos.

### Exemplo para Começar

```js
const { WhalibmobClient } = require('whalibmob')
const path = require('path')

async function connect() {
  const client = new WhalibmobClient({
    sessionDir: path.join(process.env.HOME, '.waSession')
  })

  client.on('connected', async () => {
    console.log('connected')
    await client.sendText('919634847671', 'Hello!')
  })

  client.on('disconnected', () => {
    console.log('disconnected — reconnecting...')
    setTimeout(() => connect(), 3000)
  })

  client.on('message', msg => {
    const d = msg.decoded
    if (d && d.type === 'text') console.log('message from', msg.from, d.text)
  })

  client.on('auth_failure', ({ reason }) => {
    console.error('session revoked:', reason)
    // re-register the number
  })

  await client.init('919634847671')
}

connect()
```

### Todos os Eventos

| Evento | Payload | Descrição |
|---|---|---|
| `connected` | — | Sessão autenticada e pronta |
| `disconnected` | — | Conexão fechada |
| `reconnecting` | `{ attempt, delay }` | Conexão perdida, vai tentar de novo |
| `reconnected` | — | Conexão restaurada |
| `auth_failure` | `{ reason }` | Sessão revogada ou banida |
| `message` | objeto de mensagem | Mensagem recebida |
| `receipt` | `{ type, id, from }` | Recibo de entrega / leitura / reprodução |
| `presence` | `{ from, available }` | Contato ficou online ou saiu |
| `group_update` | `{ type, groupJid, actor, participants, subject, timestamp }` | Membro adicionado / removido / promovido / rebaixado, assunto ou configurações alterados |
| `notification` | objeto de nó | Notificação de atualização de grupo ou contato |
| `call` | `{ from }` | Evento de chamada recebida |
| `chat_read` | `{ jid, read, remote?, synced? }` | Conversa marcada como lida (`read: true`) ou não lida (`read: false`) |
| `chat_muted` | `{ jid, muted, until, remote?, synced? }` | Conversa silenciada ou com som reativado; `until` é em ms de epoch (−1 = indefinido) |
| `chat_pinned` | `{ jid, pinned, remote?, synced? }` | Conversa fixada ou desafixada |
| `blocklist` | `{ action, dhash, prevDhash, changes }` | Lista de bloqueados alterada em outro dispositivo; `changes` é `[{ jid, action }]` |
| `privacy_settings` | `{ changes, settings }` | Configurações de privacidade alteradas em outro dispositivo |
| `chat_archived` | `{ jid, archived, remote?, synced? }` | Conversa arquivada ou desarquivada |
| `message_starred` | `{ msgId, chatJid, starred, fromMe?, remote?, synced? }` | Mensagem favoritada ou desfavoritada |
| `chat_removed` | `{ jid, kind, remote }` | Uma conversa foi limpa ou excluída em outro dispositivo |
| `contact_update` | `{ jid, name, firstName, lid, username, removed, remote }` | Um contato foi renomeado ou removido em outro lugar |
| `push_name_update` | `{ name, remote }` | O seu próprio nome de exibição mudou em outro dispositivo |
| `app_state_sync` | `{ collections, applied }` | Uma sincronização de app-state terminou; veja [Lendo Alterações Feitas em Outro Lugar](#lendo-alterações-feitas-em-outro-lugar) |
| `app_state_mutation` | `{ collection, index, action, removed }` | Uma alteração de app-state que esta biblioteca não modela |
| `app_state_key_missing` | `{ collection, keyId }` | O app state não pode ser lido até o seu celular compartilhar esta chave |
| `app_state_keys` | `{ keys }` | O seu celular compartilhou as chaves de sincronização do app-state; uma sincronização começa automaticamente |
| `account_restriction` | `{ active, remaining, remainingMs, endsAtDate, enforcementType, reason, source }` | A conta foi restringida ou a restrição foi levantada — veja [Quando o 463 Significa que a Conta Está Restrita](#quando-o-463-significa-que-a-conta-está-restrita) |
| `mex_notification` | `{ opName, data }` | Um push do servidor por `w:mex` que esta biblioteca não modela |

`remote: true` em um evento de conversa significa que a mudança foi feita no seu celular ou em outro
dispositivo vinculado, e não por esta sessão. As suas próprias chamadas carregam `synced` em vez disso,
dizendo se a mudança chegou ao app state — veja
[Modificando Conversas](#modificando-conversas).
| `stream_error` | `{ reason }` | O servidor enviou um erro fatal de stream |
| `decrypt_error` | `{ id, from, participant, err }` | Falha ao descriptografar uma mensagem recebida |
| `session_refresh` | `{ node }` | Sucesso em uma reautenticação tardia; sessão Signal renovada |
| `close` | — | Socket TCP subjacente fechado |
| `error` | Error | Erro de transporte não tratado |

O objeto de mensagem contém:

```js
{
  id:          string,   // unique message ID
  from:        string,   // sender JID — may be a LID (e.g. '112345678901234@s.whatsapp.net')
  participant: string,   // group member JID (groups only; equals from for DMs)
  ts:          number,   // Unix timestamp (seconds)
  node:        object,   // raw XML node — node.attrs.sender_pn holds the real phone JID
  decoded:     object,   // structured payload — shape depends on message type (see below)
}
```

> [!NOTE]
> O WhatsApp Multi-Device usa **JIDs LID** internamente. O campo `from` pode ser um LID como
> `112345678901234@s.whatsapp.net` em vez do número de telefone real. Para obter o JID do
> número de telefone de fato, sempre leia `msg.node.attrs.sender_pn`:
> ```js
> const spn = msg.node.attrs.sender_pn         // { user: '919634847671', server: 's.whatsapp.net' }
> const phoneJid = spn.user + '@s.whatsapp.net' // '919634847671@s.whatsapp.net'
> ```

O formato do objeto `decoded` por tipo de mensagem:

```js
// Text
{ type: 'text', text: string }

// Image
{ type: 'image', caption: string, url: string, mimetype: string, mediaKey: Buffer, directPath: string }

// Video
{ type: 'video', caption: string, url: string, mimetype: string, mediaKey: Buffer, directPath: string }

// Audio (music file)
{ type: 'audio', url: string, mimetype: string, mediaKey: Buffer, directPath: string }

// Voice note (push-to-talk)
{ type: 'voice', url: string, mimetype: string, mediaKey: Buffer, directPath: string }

// Document
{ type: 'document', fileName: string, url: string, mimetype: string, mediaKey: Buffer, directPath: string }

// Sticker
{ type: 'sticker', url: string, mimetype: string, mediaKey: Buffer, directPath: string }

// Reaction
{ type: 'reaction', emoji: string }

// Location
{ type: 'location', latitude: number, longitude: number, name: string, address: string, url: string }

// Contact (vCard)
{ type: 'contact', displayName: string, vcard: string }

// Personal invitation into a group — see Personal Invitations
{ type: 'groupInvite', groupJid: string, inviteCode: string, inviteExpiration: number,
  groupName: string, jpegThumbnail: Buffer|null, caption: string, isCommunity: boolean }

// Protocol (revoke, ephemeral, etc.)
{ type: 'protocol', subtype: string }
```

---

## Sincronização de Histórico

### Como a Sincronização de Histórico Funciona

Quando o whalibmob conecta, o WhatsApp envia automaticamente o histórico de conversas da conta para o cliente.
A biblioteca cuida de todo o pipeline **sem nenhuma linha de código sua** — você só precisa escutar
os eventos se quiser usar os dados.

O fluxo interno completo:

1. O servidor do WhatsApp envia um `ProtocolMessage` criptografado (tipo 6) contendo uma `HistorySyncNotification`.
2. A biblioteca o descriptografa via Protocolo Signal.
3. O `HistorySyncHandler` baixa o blob criptografado do CDN do WhatsApp (`mmg.whatsapp.net`), ou lê o payload embutido se o servidor o incorporou diretamente.
4. O blob é descriptografado com **AES-256-CBC** usando uma chave HKDF derivada de `"WhatsApp History Keys"`.
5. O resultado é descomprimido com **zlib** e decodificado de **protobuf** (WAProto v2.3000.x — números de campo verificados contra a definição proto oficial).
6. Conversas, contatos, nomes de exibição, mapeamentos LID↔PN e **tcTokens** são mesclados no store em disco.
7. Os tcTokens do histórico são semeados no `TcTokenStore` em memória para que a primeira DM de saída depois da reconexão já carregue um nó `<tctoken>` válido (evita o erro 463 na partida a frio).
8. O evento `history_sync` dispara com um resumo do que foi recebido.

O histórico chega em **vários pedaços**. Cada pedaço dispara um evento `history_sync`. O primeiro pedaço (tipo de sincronização `INITIAL_BOOTSTRAP`) costuma ser o maior e carrega as conversas mais recentes.

### Ouvindo os Eventos de Sincronização de Histórico

```js
const { WhalibmobClient } = require('whalibmob')
const path = require('path')

const client = new WhalibmobClient({
  sessionDir: path.join(process.env.HOME, '.waSession')
})

// history_sync fires once per history chunk — may fire multiple times on first connect
client.on('history_sync', result => {
  console.log('History sync chunk received:')
  console.log('  type    :', result.syncTypeName)   // e.g. 'INITIAL_BOOTSTRAP', 'RECENT', 'FULL'
  console.log('  progress:', result.progress)        // 0-100 server-reported
  console.log('  chunk   :', result.chunkOrder)
  console.log('  chats   :', result.chats.length)
  console.log('  contacts:', result.contacts.length)
  console.log('  pushNames:', (result.pushNames || []).length)
})

// history_sync_error fires if a chunk fails to download or decrypt
client.on('history_sync_error', ({ err, notification }) => {
  console.error('History sync failed:', err.message)
  console.error('  syncType:', notification.syncType)
})

await client.init('919634847671')
```

O formato do objeto `result` emitido pelo `history_sync`:

```js
{
  syncType:      number,   // HistorySyncType enum value
  syncTypeName:  string,   // 'INITIAL_BOOTSTRAP' | 'RECENT' | 'FULL' | 'PUSH_NAME' | 'NON_BLOCKING_DATA' | 'ON_DEMAND'
  progress:      number,   // 0-100, server-reported progress
  chunkOrder:    number,   // chunk sequence number
  chats: [                 // one entry per conversation in this chunk
    {
      id:               string,   // chat JID e.g. '919634847671@s.whatsapp.net' or '120363...@g.us'
      name:             string,   // display name (may be undefined for unknown contacts)
      unreadCount:      number,
      lastMsgTimestamp: number,   // Unix seconds
      messageCount:     number    // number of messages in this chunk for this chat
    }
  ],
  contacts: [              // one entry per contact discovered in this chunk
    {
      id:       string,
      name:     string,
      username: string,    // WhatsApp username if set
      pnJid:    string,    // phone-number JID e.g. '919634847671@s.whatsapp.net'
      lidJid:   string     // LID JID e.g. '112345678901234@lid'
    }
  ],
  pushNames:     Array,    // push-name entries { id, pushname }
  lidPnMappings: Array,    // LID<->PN mapping entries { lidJid, pnJid }
  merged:        object    // raw merged history store (see Reading the History Store below)
}
```

Valores do tipo de sincronização:

| `syncTypeName` | Quando dispara |
|---|---|
| `INITIAL_BOOTSTRAP` | Primeira conexão — conversas mais recentes |
| `RECENT` | Reconexão após um curto período offline |
| `FULL` | Sincronização histórica completa (mensagens mais antigas) |
| `PUSH_NAME` | Somente atualizações de nomes de contato |
| `NON_BLOCKING_DATA` | Dados de segundo plano, baixa prioridade |
| `ON_DEMAND` | Solicitado explicitamente pelo cliente |

### Arquivos Persistentes Gravados em Disco

A biblioteca grava automaticamente estes arquivos no `sessionDir`, por conta. Você não precisa criá-los nem gerenciá-los.

| Arquivo | Conteúdo |
|---|---|
| `<phone>.history.json` | Conversas, contatos, nomes de exibição, mapeamentos LID↔PN, tcTokens |
| `<phone>.messages.json` | Mapa simples de `msgId → metadados da mensagem` |
| `<phone>.appStateKeys.json` | Chaves de sincronização do app-state, compartilhadas pelo seu dispositivo principal |
| `<phone>.appState.json` | Versão, hash e mapa de índices do app-state por coleção |
| `<phone>.tctoken.json` | Store de tokens de contato confiável (tcToken por JID de contato) |

### Lendo o History Store

Depois que a sincronização de histórico termina, você pode ler os arquivos em disco diretamente:

```js
const fs   = require('fs')
const path = require('path')

const sessDir = path.join(process.env.HOME, '.waSession')
const phone   = '919634847671'

// ── Read chats ────────────────────────────────────────────────────────────────
const histPath = path.join(sessDir, phone + '.history.json')
const hist     = JSON.parse(fs.readFileSync(histPath, 'utf8'))

// List all chats sorted by last message time
const chats = Object.values(hist.chats)
  .sort((a, b) => (b.lastMsgTimestamp || 0) - (a.lastMsgTimestamp || 0))

for (const chat of chats.slice(0, 10)) {
  console.log(chat.id, '|', chat.name || '(unknown)', '|', chat.unreadCount, 'unread')
}

// ── LID ↔ PN lookup ───────────────────────────────────────────────────────────
// Look up LID JID from phone number JID
const myLid = hist.pnLidMap['919634847671@s.whatsapp.net']
console.log('LID:', myLid)   // e.g. '112345678901234@lid'

// Reverse: phone number JID from LID
const myPn = hist.lidPnMap[myLid]
console.log('PN:', myPn)

// ── Read message metadata ─────────────────────────────────────────────────────
const msgPath = path.join(sessDir, phone + '.messages.json')
const msgs    = JSON.parse(fs.readFileSync(msgPath, 'utf8'))
const msgList = Object.values(msgs).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
console.log('Total messages indexed:', msgList.length)
console.log('Latest:', msgList[0])
```

Esquema de `hist.chats` por entrada de conversa:

```js
{
  id:                     string,   // JID
  name:                   string,
  displayName:            string,
  unreadCount:            number,
  lastMsgTimestamp:       number,   // Unix seconds
  messageCount:           number,   // total messages indexed from history
  ephemeralExpiry:        number,   // disappearing messages timer in seconds, if set
  archived:               boolean,
  pinned:                 number,   // pin sort order (0 = not pinned)
  tcToken:                string,   // base64 — trusted-contact token (used internally by the library)
  tcTokenTimestamp:       number,   // Unix seconds — when the token was issued by the server
  tcTokenSenderTimestamp: number    // Unix seconds — sender-side issuance timestamp for 7-day bucket dedup
}
```

Esquema de `msgs` por entrada de mensagem:

```js
{
  id:        string,   // WhatsApp message ID
  chatId:    string,   // JID of the conversation
  fromMe:    boolean,
  fromJid:   string,   // sender JID
  timestamp: number,   // Unix seconds
  pushName:  string,   // display name of sender at send time
  status:    number    // 0=error 1=pending 2=server 3=delivered 4=read 5=played
}
```

### tcToken — Defesa contra o Erro 463

> [!IMPORTANT]
> Esta seção é informativa. Todo o ciclo de vida do tcToken é **totalmente automático**.
> Você não precisa escrever nenhum código para isso.

O WhatsApp conta toda DM de saída enviada **sem** um nó `<tctoken>` como um evento anônimo de "abordagem" (reach-out). Quando eventos suficientes desse tipo se acumulam, o servidor aplica um **Reach-out Time-lock** baseado em tempo e retorna o erro `463` (`NackCallerReachoutTimelocked`), bloqueando todas as mensagens e chamadas de saída por um período.

O whalibmob implementa o ciclo de vida completo para evitar isso:

| Passo | O que a biblioteca faz automaticamente |
|---|---|
| **Semente do histórico** | A cada pedaço de sincronização de histórico, os bytes de `tcToken` são extraídos de cada conversa no protobuf e carregados no `TcTokenStore` em memória. O primeiro envio depois da reconexão já tem um token válido pronto — sem risco de 463 na partida a frio. |
| **Primeiro contato** | A primeiríssima DM para um contato ainda não tem token registrado. Antes de a stanza ser montada, a biblioteca emite um e espera por ele, para que aquela mensagem carregue um `<tctoken>` como todas as seguintes, em vez de contar como uma abordagem anônima. A espera é limitada por `tcTokenPresendTimeoutMs` (padrão 5 s) — passado isso, a mensagem sai de qualquer jeito e o token chega a tempo para a próxima. |
| **Anexar no envio** | Antes de despachar qualquer DM, o `MessageSender` procura o token para o JID do destinatário, confere se ele não expirou (janela deslizante de 28 dias) e insere um nó filho `<tctoken>` na stanza da mensagem. |
| **Renovação** | Depois de um envio bem-sucedido de DM, a biblioteca dispara um `<iq type='set' xmlns='privacy'>` solicitando um token novo para aquele JID ao servidor — uma vez por janela de 7 dias, com deduplicação em voo. Esse é "dispare e esqueça": o token que está sendo anexado agora ainda é válido, então nada espera por ele. |
| **Notificação recebida** | Quando um contato inicia uma nova conversa, o WhatsApp envia um `<notification type='privacy_token'>`. A biblioteca o captura em `_handlePrivacyTokenNotification` e armazena o token imediatamente. |
| **Reemissão por mudança de identidade** | Ao descriptografar um `pkmsg` (nova sessão Signal vinda do par), a biblioteca chama `_reissueTcTokenAfterIdentityChange` para reemitir o token para a nova sessão. |
| **Recuperação do erro 463** | Se um envio falha com o erro 463, a biblioteca emite um token novo, espera a resposta do servidor e reenvia automaticamente a mesma mensagem com o novo token anexado. |
| **Expiração** | Os tokens usam uma janela deslizante de 4 buckets (4 × 7 dias = TTL de 28 dias). Tokens expirados são limpos antes do envio e um novo é solicitado proativamente. |

O armazenamento do token usa o **JID LID** do contato (ex.: `112345678901234@lid`) como chave — nunca o JID do número de telefone — seguindo a convenção interna do WhatsApp.

<a id="account-restriction"></a>

### Quando o 463 Significa que a Conta Está Restrita

Um `463` tem duas causas que parecem idênticas na rede, e distingui-las importa porque só uma delas vale a pena tentar de novo.

- **Nenhum token de privacidade para aquele contato específico.** A biblioteca emite um e reenvia. Este é o caso comum e ele se resolve sozinho.
- **A conta está restrita.** O WhatsApp decidiu que você está iniciando conversas demais com pessoas que nunca respondem, e recusa *todas* as novas conversas até a restrição expirar. As conversas existentes continuam funcionando, e é por isso que a conta parece saudável no resto. Nenhuma nova tentativa ajuda — e enviar mais conta como mais abordagens, o que aumenta a duração.

A expiração nunca é enviada a um cliente que não perguntou. O `fetchReachoutTimelock()` é a única forma de descobri-la:

```js
const r = await client.fetchReachoutTimelock()

if (r.active) {
  console.log('restricted:', r.reason)
  console.log('ends at:   ', r.endsAtDate.toISOString())
  console.log('remaining: ', r.remaining)      // '04:59:20'
} else {
  console.log('not restricted')
}
```

```js
{
  active:          true,
  remaining:       '04:59:20',   // HH:MM:SS, hours not wrapped at 24
  remainingMs:     17960000,
  endsAt:          1800018000000,
  endsAtDate:      Date,
  enforcementType: 'BIZ_QUALITY',
  reason:          'too many people you messaged blocked or reported you',
  expiryUnknown:   false,        // true when the server withheld the end time
  checkedAt:       1800000040000
}
```

O `getReachoutTimelock()` retorna o mesmo formato a partir do que foi aprendido por último, sem perguntar de novo — a contagem regressiva é recalculada a cada chamada, então é o que uma exibição de uma vez por segundo lê.

**Você raramente precisa chamar qualquer um dos dois.** Um envio recusado com 463 dispara uma verificação por conta própria (limitada a uma por minuto), e o servidor envia uma atualização tanto quando uma restrição começa quanto quando ela é levantada:

```js
client.on('account_restriction', (r) => {
  if (r.active) console.log('restricted for', r.remaining, '—', r.reason)
  else          console.log('restriction lifted')
})
```

`r.source` é `'notification'` quando o servidor anunciou e `'query'` quando fomos nós que perguntamos.

> [!NOTE]
> Uma primeira restrição costuma durar cerca de cinco horas. As repetições ficam mais longas. Nada
> do lado do cliente a encurta; a única coisa que ajuda é não enviar mais
> primeiras mensagens sem resposta enquanto ela estiver ativa.

> [!NOTE]
> **Este transporte responde em uma de duas codificações**, e a resposta diz qual:
> JSON, ou Argo — a codificação binária compacta da Meta para GraphQL. As duas são lidas.
> O WhatsApp envia Argo com a flag autodescritiva ligada, então ele carrega os próprios
> nomes de campo e decodifica sem o schema GraphQL contra o qual a consulta foi
> escrita.
>
> Não adicione um atributo `format` à consulta na esperança de controlar isso — isso
> foi tentado contra um servidor ao vivo, que respondeu descartando a stanza
> inteira e não respondendo nada.
>
> Alguns servidores respondem de forma seca — um simples `false` ou `true` em vez do objeto
> com a expiração dentro. `false` é entendido como "sem restrição", porque é uma
> resposta definitiva e não uma ausente. `true` marca `active` com
> `expiryUnknown: true`, já que diz que há uma restrição mas não quando ela
> termina; a contagem regressiva vem então do anúncio.
>
> Uma resposta que não é nenhum dos dois — `null`, ou qualquer coisa que não diga nada —
> lança erro com o valor decodificado em `err.mexDecoded`, em vez de ser reportada
> como "sem restrição". Um "tudo certo" inventado a partir de uma resposta que nunca deu um
> faria você enviar mais mensagens e prolongar exatamente a restrição sobre a qual você estava
> perguntando.
>
> O evento `account_restriction` não depende de nada disso. O servidor
> *anuncia* uma restrição começando e sendo levantada, e esses anúncios carregam
> a contagem regressiva. Mantenha um listener ligado e você fica sabendo de qualquer jeito.

### O que É Automático e o que Você Precisa Fazer

**Tudo na coluna "Automático" não exige nenhuma linha de código sua.**

| Recurso | Automático | Observações |
|---|---|---|
| Baixar o blob de histórico do CDN | ✅ | |
| Descriptografar o blob de histórico (AES-256-CBC + HKDF) | ✅ | |
| Descomprimir zlib | ✅ | |
| Decodificar protobuf (WAProto v2.3000.x) | ✅ | Números de campo verificados contra o proto oficial |
| Persistir conversas / contatos / nomes de exibição | ✅ | Gravado em `<phone>.history.json` |
| Persistir metadados de mensagens | ✅ | Gravado em `<phone>.messages.json` |
| Persistir chaves de sincronização do app-state | ✅ | Gravado em `<phone>.appStateKeys.json` |
| Sincronizar o app state quando o servidor avisa que mudou | ✅ | Fixados, arquivados, silenciados, favoritos, nomes de contato |
| Verificar os MACs do app-state e o hash LT | ✅ | Uma coleção que sai de sincronia é relida de um snapshot |
| Persistir as versões do app-state entre reinícios | ✅ | Gravado em `<phone>.appState.json` |
| Semear tcTokens na memória ao conectar | ✅ | Evita o erro 463 no primeiro envio após a reconexão |
| Anexar o tcToken a toda DM de saída | ✅ | |
| Emitir tcTokens novos após cada envio | ✅ | Uma vez por janela de 7 dias por contato |
| Tratar notificações `privacy_token` recebidas | ✅ | |
| Reemitir o tcToken após mudança de identidade do par | ✅ | |
| Recuperar-se do erro 463 com nova tentativa automática | ✅ | |
| Verificar restrição de conta após um 463 | ✅ | Limitado a uma vez por minuto |
| Acompanhar início / fim de restrição enviado pelo servidor | ✅ | Emitido como `account_restriction` |
| Preencher os mapas LID↔PN em memória | ✅ | |
| Escutar o evento `history_sync` | 🔵 Opcional | Só se o seu app precisa reagir aos dados de histórico |
| Ler `<phone>.history.json` | 🔵 Opcional | Só se o seu app precisa dos dados de conversa/contato em repouso |
| Ler `<phone>.messages.json` | 🔵 Opcional | Só se o seu app indexa mensagens |

**Integração mínima funcional — sincronização de histórico, tcTokens e defesa contra o erro 463 todos ativos com zero código extra:**

```js
const { WhalibmobClient } = require('whalibmob')
const path = require('path')

const client = new WhalibmobClient({
  sessionDir: path.join(process.env.HOME, '.waSession')
})

// History sync, tcToken seeding, error-463 defense, and all disk persistence
// happen automatically. Add the listeners below only if your app needs the data.

client.on('history_sync', result => {
  // Optional — fires once per chunk (multiple times on first connect)
  console.log('[', result.syncTypeName, ']',
    result.chats.length, 'chats,',
    result.contacts.length, 'contacts')
})

client.on('history_sync_error', ({ err }) => {
  // Optional — log failures (library continues working even if a chunk fails)
  console.error('History chunk failed:', err.message)
})

await client.init('919634847671')
```


## Recebendo Mídia

Quando uma mensagem de mídia chega, o `msg.decoded` carrega a localização no CDN e a
`mediaKey` sob a qual o arquivo está criptografado. O `client.downloadMedia()` o busca e
devolve os bytes em texto claro:

```js
const fs = require('fs')

const EXT = { image: '.jpg', video: '.mp4', audio: '.ogg', voice: '.ogg',
              sticker: '.webp', document: '' }

client.on('message', async (msg) => {
  const d = msg.decoded
  if (!d || !d.mediaKey) return

  try {
    const bytes = await client.downloadMedia(d)
    const name  = d.fileName || (msg.id + (EXT[d.type] || ''))
    fs.writeFileSync(name, bytes)
    console.log('saved', d.type, 'to', name)
  } catch (e) {
    console.error('media download failed:', e.message)
  }
})
```

Funciona igual nos dois modos, e esse é justamente o ponto: o CDN aplica uma
verificação de navegador tanto na **descida** quanto na subida, então um companion também precisa
se identificar como tal aqui. Fazer isso na mão significa saber disso, e
saber de qual nome de chave HKDF cada tipo de mídia deriva — uma mensagem de voz deriva
das chaves de PTT e um GIF das de vídeo, e não das próprias. Erre qualquer um dos dois
e o download é recusado ou a descriptografia produz lixo.

O objeto de mensagem inteiro é aceito tanto quanto a metade `decoded` dele, então
`client.downloadMedia(msg)` faz a mesma coisa.

**Verificando o arquivo**

Passe `{ verify: true }` para conferir o download contra o `fileEncSha256` da
mensagem antes de descriptografá-lo. O MAC já prova que o texto claro não foi
adulterado; isso pega um download truncado ou substituído mais cedo, e
nomeia essa falha separadamente de uma falha de descriptografia.

```js
const bytes = await client.downloadMedia(d, { verify: true })
```

**O que acontece por baixo**

1. O blob criptografado é buscado em `url`, ou em `directPath` quando a
   mensagem não carrega uma URL absoluta.
2. O HKDF-SHA256 expande a `mediaKey` em um IV, uma chave de cifra e uma chave de MAC, usando
   a string de info daquele tipo de mídia.
3. O HMAC-SHA256 de 10 bytes no final é verificado, e então o AES-256-CBC descriptografa o
   resto.

O `downloadMedia` lança erro com o motivo em vez de retornar vazio: uma mensagem
sem mídia, sem localização no CDN, com um tipo não suportado, ou um arquivo que não
corresponde à mensagem — todos dizem isso.

### Quando o Arquivo Sumiu do CDN

A mídia não é transportada dentro da mensagem — a mensagem carrega uma URL, um hash e
a chave, e os bytes ficam no CDN do WhatsApp por tempo limitado. Um download que
responde **404** ou **410** não tem mais nada para buscar. Isso é mais comum em
mensagens que chegam pela sincronização de histórico bem depois de terem sido enviadas.

O celular do remetente ainda tem o original, e pode ser solicitado a enviá-lo de novo:

```js
client.on('media_retry', (notification) => {
  const result = client.decryptMediaRetry(notification, mediaKey)
  if (result.ok) {
    // fresh location — download it the usual way
    console.log('re-uploaded at', result.directPath)
  } else {
    // the phone no longer has it either; nothing further to try
  }
})

try {
  await client.downloadMedia(msg)
} catch (err) {
  if (/404|410/.test(err.message)) {
    await client.requestMediaRetry({
      id:          msg.key.id,
      chatJid:     msg.key.remoteJid,
      fromMe:      msg.key.fromMe,
      // groups only — the member who sent it
      participant: msg.key.participant
    }, mediaKey)
  }
}
```

O `requestMediaRetry` resolve assim que a requisição está na rede; a resposta
chega depois no evento `media_retry`, e é por isso que as duas metades são
escritas separadamente. Guarde a `mediaKey` — a resposta é criptografada sob uma chave
derivada dela, e sem ela a nova localização não pode ser lida.

Essa derivação também é o que torna a requisição segura de enviar: ela prova que quem
pediu foi um destinatário da mensagem, e não alguém que apenas conhece um
id de mensagem, então nenhum celular pode ser levado a reenviar um arquivo sob demanda.

## Enviando Mensagens

### Mensagem de Texto

```js
await client.sendText('919634847671', 'Hello!')
```

### Citar Mensagem

Para a resposta com citação mais simples, use [`sendReply`](#resposta-com-citação). Se você precisa de controle de baixo nível (ex.: citar uma mensagem que não é de texto), passe um objeto `contextInfo` diretamente para o `sendText`:

```js
// low-level: pass contextInfo manually inside sendText options
await client.sendText(
  '919634847671@s.whatsapp.net',
  'This is a reply',
  {
    contextInfo: {
      quotedMessageId: 'ABCDEF123456',          // ID of the quoted message
      participant:     '919634847671@s.whatsapp.net',  // sender of the quoted message
      remoteJid:       '919634847671@s.whatsapp.net',  // chat JID
    }
  }
)
```

### Mencionar Usuário

```js
await client.sendText(
  '120363000000000000@g.us',
  '@919634847671 hello!',
  { mentions: ['919634847671@s.whatsapp.net'] }
)
```

### Mensagem de Reação

```js
// react to a message
await client.sendReaction('919634847671', 'MSGID123', '👍')

// remove a reaction — pass empty string
await client.sendReaction('919634847671', 'MSGID123', '')
```

### Editar Mensagem

> [!NOTE]
> A edição só é possível dentro de 15 minutos após o envio original.

```js
await client.editMessage(
  'MSGID123',                           // original message ID
  '919634847671@s.whatsapp.net',
  'Corrected text here'
)
```

### Apagar Mensagem

```js
// delete for yourself only
await client.deleteMessage('MSGID123', '919634847671', true, false)

// delete for everyone (revoke)
await client.deleteMessage('MSGID123', '919634847671', true, true)
```

### Encaminhar Mensagem

Encaminhe texto ou uma mensagem de mídia completa (imagem, vídeo, áudio, documento, figurinha) sem
reenviar o arquivo.  Passe um objeto de mensagem decodificado vindo do evento `message` para encaminhar qualquer tipo de mídia.

```js
// Forward text
await client.forwardMessage('919634847671', 'text to forward')

// Forward any received message (full media, no re-upload)
client.on('message', async (msg) => {
  if (msg.decoded && msg.decoded.type !== 'text') {
    await client.forwardMessage('919634847671', msg)
  }
})
```

### Enquete

Envia uma enquete do WhatsApp.  `selectableCount` é quantas opções um votante pode escolher (0 = qualquer quantidade).

```js
const { id, encKey } = await client.sendPoll(
  '919634847671@s.whatsapp.net',
  'Best language?',
  ['JavaScript', 'Python', 'Rust'],
  1            // voters may pick 1 option (0 = unlimited)
)
// encKey (32-byte Buffer) is needed to decrypt incoming poll votes
// (also returned as `messageSecret`, which is the name the protocol uses)
```

### Resposta com Citação

Envia uma mensagem de texto que cita (responde a) uma mensagem anterior específica. O destinatário vê a mensagem original destacada acima da sua resposta.

```js
// DM: senderJid is the same as the chat JID
await client.sendReply(
  '919634847671@s.whatsapp.net',  // chat JID
  '3EB0XXXXXXXX',                 // ID of the quoted message
  '919634847671@s.whatsapp.net',  // sender of the quoted message (same as chat for DMs)
  'Got it, thanks!'               // your reply text
)

// Group: senderJid is the group member who sent the quoted message
await client.sendReply(
  '120363000000000000@g.us',      // group JID
  '3EB0XXXXXXXX',                 // ID of the quoted message
  '919634847671@s.whatsapp.net',  // who sent the original message
  'Agreed!'
)
```

Você pode obter o `id` de uma mensagem recebida em `msg.id` dentro do evento `message`.

### Mensagem de Localização

Envia um pino de localização GPS. `name` e `address` são rótulos opcionais mostrados abaixo da prévia do mapa.

```js
// minimal — lat/lon only
await client.sendLocation('919634847671', 48.8566, 2.3522)

// with name and address
await client.sendLocation('919634847671', 48.8566, 2.3522, {
  name:    'Eiffel Tower',
  address: 'Champ de Mars, 5 Av. Anatole France, Paris'
})

// to a group
await client.sendLocation('120363000000000000@g.us', 51.5074, -0.1278, {
  name: 'London'
})

// with a map image for the bubble — WhatsApp draws a blank card without one
await client.sendLocation('919634847671', 48.8566, 2.3522, {
  name: 'Eiffel Tower',
  thumbnail: jpegBuffer
})
```

### Mensagem de Contato (vCard)

Envia um cartão de contato usando o formato padrão vCard v3. O destinatário pode salvar o contato direto do WhatsApp.

```js
const vcard = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'FN:Alice Smith',
  'TEL;TYPE=CELL:+919634847671',
  'EMAIL:alice@example.com',
  'END:VCARD'
].join('\n')

await client.sendContact('919634847671', 'Alice Smith', vcard)
```

### Link de Chamada

Pede ao WhatsApp um link que permite alguém entrar em uma chamada tocando nele, em vez de
ser chamado. Retorna o token, o link compartilhável e o tipo de mídia.

```js
const { link } = await client.createCallLink('video')
// https://call.whatsapp.com/video/XXXXXXXX

// audio is the default
const audio = await client.createCallLink()

// schedule it — startTime is seconds since the epoch
await client.createCallLink('video', { startTime: 1800000000 })

// create it and send it in one step
await client.sendCallLink('919634847671', 'video', {
  text: 'Join me here:'
})
```

## Mensagens de Mídia

Fotos e vídeos são enviados com uma prévia embutida para que apareçam na conversa
diretamente, em vez de como um espaço reservado no qual o destinatário precisa tocar. As dimensões
são lidas do cabeçalho do arquivo sem dependência nenhuma. A prévia em si
usa o `jimp` (instalado automaticamente como dependência opcional) ou o `sharp` se
você o tiver; faltando os dois, uma foto que carrega uma miniatura EXIF ganha uma
de graça, e qualquer outra coisa é redimensionada no próprio processo — JPEG, PNG, GIF e BMP funcionam
sem nada instalado. As prévias de vídeo precisam do `ffmpeg` no PATH — no Termux,
`pkg install ffmpeg`. Sem nada disso a mídia ainda é enviada, só que sem
a prévia.

### Mensagem de Imagem

```js
// from file path
await client.sendImage('919634847671', './photo.jpg', { caption: 'Look at this' })

// from Buffer
await client.sendImage('919634847671', buffer, {
  caption: 'Photo',
  mimetype: 'image/jpeg'
})
```

### Mensagem de Vídeo

```js
await client.sendVideo('919634847671', './clip.mp4', { caption: 'Watch this' })
```

### Mensagem de Áudio

```js
await client.sendAudio('919634847671', './song.mp3')
```

### Mensagem de Voz (PTT)

```js
// ptt: true renders the audio as a push-to-talk voice note with waveform
await client.sendAudio('919634847671', './voice.ogg', { ptt: true })
```

### Mensagem de Documento

```js
await client.sendDocument('919634847671', './report.pdf', {
  fileName: 'Q1 Report.pdf'
})
```

### Mensagem de Figurinha

```js
await client.sendSticker('919634847671', './sticker.webp')
```

## Status / Stories

Um Status é publicado em `status@broadcast` e percorre o caminho de SenderKey que uma
mensagem de grupo percorre — um corpo criptografado mais uma distribuição de chave para cada destinatário.
Quem são esses destinatários vem das suas configurações de privacidade de status, resolvidas
contra os contatos no history store sincronizado.

```js
// text
await client.sendStatus('Good morning!')

// photo, video, voice — same arguments as the matching send* methods
await client.sendStatus({ image: './photo.jpg', caption: 'Look at this' })
await client.sendStatus({ video: './clip.mp4' })
await client.sendStatus({ audio: './voice.ogg' })

// styled text status
await client.sendStatus('Colorful', { backgroundArgb: 0xFF25D366, font: 3 })

// post to an explicit list instead of the privacy-derived one
await client.sendStatus('Hi', { recipients: ['919634847671'] })
```

### Privacidade do Status

```js
const [def, ...rest] = await client.queryStatusPrivacy()
// def = { type: 'contacts' | 'blacklist' | 'whitelist', isDefault, list }
```

`contacts` envia para todo mundo na sua agenda, `blacklist` para todos
menos os de `list`, `whitelist` somente para os de `list`. O seu próprio JID é sempre incluído para que
a publicação chegue aos seus outros dispositivos.

Os destinatários são tirados dos contatos nomeados que a sincronização de histórico trouxe; quando não
há nenhum, entram no lugar as pessoas com quem você tem conversas. Se nenhum dos dois for conhecido,
o `sendStatus` avisa em vez de publicar uma mensagem cuja chave ninguém tem —
passe `recipients` nesse caso.

## Estados de Envio na Conversa

### Marcando Mensagens como Lidas

```js
// mark all messages in a chat as read (sends IQ to server)
await client.markChatRead('919634847671')
```

### Marcar Mensagem de Voz como Reproduzida

Envia um recibo `played` para uma mensagem de voz recebida (áudio push-to-talk). Isso avisa ao remetente que você ouviu a mensagem.

```js
// msgId: ID of the audio message, from: JID of the sender
client.markMessagePlayed('3EB0ABCDEF123456', '919634847671')
```

### Atualizar Presença

```js
// set yourself as online / offline globally
client.setOnline(true)
client.setOnline(false)

// show typing or recording in a specific chat
client.setChatPresence('919634847671', 'composing')   // typing
client.setChatPresence('919634847671', 'recording')   // recording audio
client.setChatPresence('919634847671', 'paused')      // stopped
```

## Modificando Conversas

Fixar, arquivar, silenciar, marcar como lida e favoritar são **app state**. Esse é
o próprio store de configurações sincronizadas do WhatsApp — o mesmo em que o seu celular escreve —
então uma alteração feita aqui aparece no celular e em todos os outros dispositivos vinculados,
e sobrevive a uma reinstalação.

Cada um desses é `async`, envia um patch e espera o servidor aceitá-lo.
A visão local só muda depois que a alteração é de fato armazenada, e eles lançam erro se
o servidor recusar.

Eles retornam um booleano: **se a alteração chegou ao app state**, e portanto se
os outros dispositivos vão vê-la.

```js
const synced = await client.pinChat('919634847671')
if (!synced) console.log('pinned here, but your phone will not know')
```

> [!IMPORTANT]
> **O app state precisa de uma chave, e de onde vem essa chave depende de como você
> conectou.**
>
> Uma **sessão vinculada** (código de pareamento) é um companion. O seu celular compartilha uma chave
> de app state com ela automaticamente, pouco depois da vinculação — então tudo nesta
> página funciona, nos dois sentidos.
>
> Uma **sessão por SMS** *é* o dispositivo principal. Ninguém compartilha chave com ela,
> porque ela é o dispositivo que criaria uma. A menos que você tenha vinculado um
> companion a ela, não há app state para ler ou escrever.
>
> Verifique com `client.canSyncAppState()`.
>
> Quando não há chave, essas chamadas **não lançam erro**. `muteChat`, `unmuteChat`
> e `markChatRead` caem para a requisição que um dispositivo principal envia para si mesmo,
> que é o que esta biblioteca fazia antes de o app state existir. `pinChat`,
> `archiveChat` e `starMessage` não têm requisição equivalente, então atualizam somente esta
> sessão. De qualquer forma, o valor de retorno é `false`, que é como você descobre.

### Arquivar / Desarquivar uma Conversa

```js
await client.archiveChat('919634847671')
await client.unarchiveChat('919634847671')
```

### Silenciar / Reativar Som de uma Conversa

```js
await client.muteChat('919634847671', 8 * 60 * 60 * 1000)  // 8 hours
await client.muteChat('919634847671', 0)                   // until unmuted
await client.unmuteChat('919634847671')
```

### Marcar uma Conversa como Lida / Não Lida

Este é o próprio selo de não lida da conversa. Para enviar recibos de leitura (tiques azuis) de
mensagens específicas, use o `markRead()`.

```js
await client.markChatRead('919634847671')
await client.markChatUnread('919634847671')
```

### Fixar / Desafixar uma Conversa

```js
await client.pinChat('919634847671')
await client.unpinChat('919634847671')
```

### Favoritar / Desfavoritar uma Mensagem

O terceiro argumento diz se a mensagem sendo favoritada é uma que você enviou. Ele é
parte de como o favorito é arquivado, então errar isso favorita outra mensagem.

```js
await client.starMessage('MSGID123', '919634847671', true)   // yours
await client.unstarMessage('MSGID123', '919634847671', false) // theirs
```

<a id="app-state-sync"></a>

### Lendo Alterações Feitas em Outro Lugar

O tráfego corre nos dois sentidos. Quando você fixa uma conversa no celular, silencia um grupo em
outro dispositivo vinculado, ou renomeia um contato, essa alteração fica esperando no app state
para esta sessão pegar.

O `syncAppState()` a busca. Ele é chamado por você sempre que o servidor avisa que
algo mudou — então, com um listener ligado, você geralmente nunca precisa
chamá-lo manualmente. Em uma sessão por SMS sem companions vinculados não há nada a
buscar, e ele reporta `waitingForKeys` em vez disso.

```js
client.on('chat_pinned',     (u) => u.remote && console.log('pinned elsewhere:', u.jid))
client.on('chat_archived',   (u) => u.remote && console.log('archived elsewhere:', u.jid))
client.on('chat_muted',      (u) => u.remote && console.log('muted elsewhere:', u.jid, u.until))
client.on('chat_read',       (u) => u.remote && console.log('read elsewhere:', u.jid))
client.on('message_starred', (u) => u.remote && console.log('starred elsewhere:', u.msgId))
client.on('contact_update',  (u) => console.log('contact renamed:', u.jid, u.name))
client.on('push_name_update',(u) => console.log('your display name is now', u.name))
```

`remote: true` marca uma alteração como obra de outra pessoa. As suas próprias chamadas emitem os
mesmos eventos sem isso — elas carregam `synced` em vez disso — então um listener consegue distinguir
os dois e evitar ecoar uma alteração de volta para onde ela veio.

Para puxar sob demanda:

```js
// everything
const r = await client.syncAppState()
console.log(r.applied, 'change(s)')

// or just one part of it
await client.syncAppState(['regular_low'])

// re-read everything from scratch, discarding what we hold
await client.syncAppState(null, { snapshot: true })
```

O resultado reporta cada coleção separadamente:

```js
{
  applied: 3,
  collections: {
    regular_low: { version: 41, applied: 3, skipped: 0, snapshot: false, macOk: true }
  }
}
```

As cinco coleções são `critical_block`, `critical_unblock_low`,
`regular_high`, `regular_low` e `regular`. Em qual delas uma configuração fica é
escolha do WhatsApp, não sua — os métodos acima já arquivam cada alteração onde
ela pertence.

**Quando ele se conserta sozinho.** Cada coleção carrega um hash corrente que precisa
continuar batendo com o do servidor. Se parar de bater — um patch se perdeu, ou um
não pôde ser descriptografado — o histórico incremental deixa de ser confiável, então
aquela coleção é descartada e relida por inteiro. Isso acontece sozinho, uma vez
por sincronização, e aparece como `snapshot: true` no resultado.

**Eventos para tudo o que não é modelado aqui.** O WhatsApp acompanha mais coisas no app state do que
esta biblioteca transforma em métodos. Em vez de descartá-las, elas são emitidas
cruas, para que ao menos fique visível que algo aconteceu:

```js
client.on('app_state_mutation', ({ collection, index, action, removed }) => {
  console.log('unhandled app state change', index)
})
```

### Mensagens Temporárias

| Duração | Segundos |
|---|---|
| Desligado | 0 |
| 24 horas | 86 400 |
| 7 dias | 604 800 |
| 90 dias | 7 776 000 |

```js
// set disappearing timer for a specific chat (DM or group)
await client.changeEphemeralTimer('919634847671', 86400)
await client.changeEphemeralTimer('120363000000000000@g.us', 604800)

// remove disappearing messages
await client.changeEphemeralTimer('919634847671', 0)
```

## Consultas de Usuário

### Verificar se um Número Tem WhatsApp

```js
const { checkNumberStatus } = require('whalibmob')

const result = await checkNumberStatus('919634847671')
// result.status: 'registered' | 'registered_blocked' | 'not_registered' | 'cooldown' | 'unknown'
console.log(result.status)
```

Verifique vários números de uma vez enquanto estiver conectado:

```js
const results = await client.hasWhatsapp(['919634847671', '12345678901'])
// returns array of JIDs that have WhatsApp
```

### Buscar o Recado do Perfil

```js
const about = await client.queryAbout('919634847671')
console.log(about)

// your own, asked the same way
console.log(await client.queryOwnAbout())
```

### Buscar a Foto de Perfil

```js
const url = await client.queryPicture('919634847671')
// also works for groups
const groupUrl = await client.queryPicture('120363000000000000@g.us')
```

### Assinar a Presença

```js
// triggers 'presence' events when the contact comes online or goes offline
client.subscribeToPresence('919634847671')

client.on('presence', ({ from, available }) => {
  console.log(from, available ? 'online' : 'offline')
})
```

## Alterar o Perfil

### Alterar o Nome de Exibição

```js
client.changeName('My Bot')
```

### Alterar o Texto do Recado

```js
await client.changeAbout('Available 24/7')

// what the server actually has now — the set IQ is answered before the new
// text has to be visible anywhere, so this is the part worth reading
const stored = await client.queryOwnAbout()
```

O `changeAbout` lança erro quando o servidor recusa a alteração ou nunca responde; ele
costumava devolver a resposta sem ler, então uma recusa parecia exatamente um sucesso.
Um recado é limitado a 139 caracteres — um mais longo é descartado em vez de
recusado, e isso também agora é um erro lançado em vez de silêncio.

Um recado que o servidor armazena e ninguém consegue ver é uma configuração de privacidade, e não uma
escrita falha. A categoria que rege quem pode lê-lo é `status`:

```js
await client.changePrivacySetting('status', 'all')
```

### Alterar a Foto de Perfil

Os dois métodos aceitam um **Buffer** (use `fs.readFileSync` para carregar um arquivo).

```js
const fs = require('fs')

// change your own profile picture — any image, any shape, any size
// returns the new picture id, or 'remove' when it was taken down
const picId = await client.changeProfilePicture(fs.readFileSync('./avatar.jpg'))

// pass null to remove it
await client.changeProfilePicture(null)

// change a group's picture (you must be admin)
// returns the new picture id, or 'remove' when the picture was taken down
const picId = await client.changeGroupPicture('120363000000000000@g.us',
  fs.readFileSync('./group.jpg'))

// pass null to remove the current picture
await client.changeGroupPicture('120363000000000000@g.us', null)
```

O `changeGroupPicture` lança erro quando o servidor recusa — `406` para uma imagem que ele não
aceita, `403` quando você não é administrador daquele grupo.

> [!NOTE]
> Os dois são endereçados de formas diferentes, e isso importa. Uma foto de grupo nomeia o
> grupo no `target` do IQ; a sua própria foto não nomeia ninguém — o servidor tira
> isso da sessão. O seu próprio JID no `target` não é um erro que o servidor
> reporta, é uma stanza que ele descarta sem responder.

**As duas chamadas recodificam a imagem antes de enviá-la.** O WhatsApp quer um JPEG
quadrado de 640×640, e uma foto que não seja isso é *descartada sem resposta*
em vez de recusada — então um arquivo não preparado falha como um timeout que parece uma
falha de rede. A imagem é cortada em quadrado, redimensionada e gravada como um JPEG novo,
o que também remove o EXIF e qualquer codificação progressiva que o arquivo carregava.

**Nenhuma biblioteca de imagem é necessária.** JPEG, PNG, GIF e BMP são decodificados, cortados
e recodificados no próprio processo, então um simples `npm install` em um celular ou um contêiner
construído sem compilador converte uma foto tão bem quanto um desktop completo.
O que estiver instalado é preferido, e os fallbacks rodam nesta ordem:

| | Trata | Precisa de |
|---|---|---|
| `sharp` ou `jimp` | tudo, melhor qualidade | qualquer um dos dois instalado |
| embutido | JPEG, PNG, GIF, BMP | nada |
| `ffmpeg` | WebP, HEIC, JPEG progressivo | `ffmpeg` no PATH |
| remoção de metadados | um JPEG já quadrado | nada |

O conversor embutido também lê a tag de orientação do EXIF, então uma foto tirada em
retrato é endireitada em vez de chegar deitada, e ele achata a
transparência sobre branco, já que um JPEG não tem canal alfa.

Só um formato exótico sem nada instalado — um WebP ou um HEIC em uma máquina
sem `ffmpeg` — ainda falha, e o erro diz isso em vez de reportar um
`406` seco.

```js
// skip the re-encode if you have prepared the image yourself
await client.changeProfilePicture(buf, { raw: true })

// or choose the size
await client.changeProfilePicture(buf, { size: 640, quality: 50 })
```

## Privacidade

### Bloquear / Desbloquear Usuário

```js
// both return the updated block list, and throw if the server refuses
const blocked = await client.blockContact('919634847671')
await client.unblockContact('919634847671')

// the block list is addressed by LID; a phone number is resolved to one first,
// looking it up if it is not already known

// blocking done from the phone arrives as an event
client.on('blocklist', ({ changes }) => console.log(changes))
```

### Obter a Lista de Bloqueados

```js
const list = await client.queryBlockList()
console.log(list)   // [ '919634847671@s.whatsapp.net', ... ]
```

### Atualizar as Configurações de Privacidade

```js
// type:  'last_seen' | 'profile_picture' | 'status' | 'online' | 'read_receipts'
//        'groups_add' | 'call_add' | 'messages' | 'defense' | 'stickers'
// value: 'all' | 'contacts' | 'contact_blacklist' | 'contact_allowlist' | 'none'
//        'match_last_seen' | 'known' | 'on_standard' | 'off'

// returns the settings as they now stand; throws if the server refuses
await client.changePrivacySetting('last_seen',        'contacts')
await client.changePrivacySetting('profile_picture',  'contacts')
await client.changePrivacySetting('status',           'contacts')
await client.changePrivacySetting('online',           'match_last_seen')
await client.changePrivacySetting('read_receipts',    'none')
await client.changePrivacySetting('groups_add',       'contacts')
await client.changePrivacySetting('call_add',         'known')
```

**Cada configuração aceita os seus próprios valores**, e eles não são intercambiáveis:

| configuração | aceita |
|---|---|
| `last_seen`, `profile_picture`, `status`, `groups_add` | `all` · `contacts` · `contact_blacklist` · `none` |
| `read_receipts` | `all` · `none` |
| `online` | `all` · `match_last_seen` |
| `call_add` | `all` · `known` |
| `messages` | `all` · `contacts` |
| `defense` | `on_standard` · `off` |
| `stickers` | `contacts` · `contact_allowlist` · `none` |

Palavras mais amigáveis são traduzidas: `on`, `off`, `everyone`, `nobody`,
`my_contacts`, `contacts_except`, `contact_whitelist`. `on` vira `all` — ou
`on_standard` para `defense`, que escreve o estado ligado de outro jeito.

```js
await client.changePrivacySetting('read_receipts', 'on')    // sent as 'all'
await client.changePrivacySetting('read_receipts', 'off')   // sent as 'none'
```

Um valor que a configuração não aceita lança erro antes de qualquer coisa ser enviada. Isso importa
mais do que parece: o servidor não recusa um valor desconhecido, ele descarta a
stanza e nunca responde, então o erro apareceria como um timeout
que parece um problema de rede.

### Ler as Configurações de Privacidade

```js
const s = await client.queryPrivacySettings()
// { lastSeen, profile, status, online, readReceipts,
//   groupAdd, callAdd, messages, defense, stickers }
// anything the server did not report is null

await client.queryPrivacySettings({ force: true })   // skip the cache

// a change made on the phone arrives as an event
client.on('privacy_settings', ({ changes, settings }) => console.log(changes))
```

Desligar o `read_receipts` muda quais recibos de leitura saem: eles viram
`read-self`, que sincroniza o estado de leitura entre os seus próprios dispositivos sem avisar
o remetente. As configurações são buscadas uma vez depois da conexão, então isso já vale a partir da
primeira mensagem.

### Atualizar o Modo Temporário Padrão

```js
// sets the default ephemeral timer for all new chats
await client.changeNewChatsEphemeralTimer(86400)   // 1 day
await client.changeNewChatsEphemeralTimer(0)       // off
```

## Grupos

### Criar um Grupo

Retorna o mesmo objeto de metadados que o `getGroupMetadata` (jid, subject, participants, etc.).

```js
const group = await client.createGroup('My Group', [
  '919634847671@s.whatsapp.net',
  '12345678901@s.whatsapp.net'
])
console.log('created', group.jid)       // '120363000000000000@g.us'
console.log('subject', group.subject)   // 'My Group'
console.log('members', group.participants.map(p => p.jid))
```

### Adicionar / Remover ou Rebaixar / Promover

Cada um destes retorna um resultado por participante — os que deram certo
e os que não deram. O servidor decide cada participante separadamente, então uma
chamada que funcionou pela metade te diz qual metade e por quê.

```js
const groupJid = '120363000000000000@g.us'

const results = await client.addGroupParticipants(groupJid, [
  '919634847671@s.whatsapp.net',
  '12345678901@s.whatsapp.net'
])

for (const r of results) {
  if (r.ok) console.log('added', r.jid)
  else      console.log('failed', r.jid, r.status, r.needsInvite ? '(invite instead)' : '')
}

await client.removeGroupParticipants(groupJid,  ['919634847671'])
await client.promoteGroupParticipants(groupJid, ['919634847671'])
await client.demoteGroupParticipants(groupJid,  ['919634847671'])
```

Cada resultado é assim:

```js
{
  jid:         '919634847671@s.whatsapp.net',
  status:      '403',        // '200' when the action went through
  error:       403,          // null on success
  ok:          false,        // getter: error == null
  admin:       null,         // 'admin' | 'superadmin' | null
  phoneNumber: '919634847671@s.whatsapp.net',
  lid:         '112713111982325@lid',   // when the server told us one
  displayName: null,
  // Only on a refused add: the code a personal invitation is built from.
  addRequest:  { code: 'AbCdEfGh', expiration: 1790000000 },
  needsInvite: true          // getter: true when addRequest holds a code
}
```

Os códigos de erro comuns são `403` (as configurações de privacidade da pessoa não permitem),
`404` (não está no WhatsApp), `408` (não é membro), `409` (já é membro) e
`401` (você não tem permissão para isso).

> [!TIP]
> Um objeto de resultado é convertido em string como o seu JID, então `results.join(', ')` e
> `String(results[0])` funcionam exatamente como funcionavam quando esses métodos retornavam uma
> lista simples de strings de JID.

### Alterar o Assunto

```js
await client.changeGroupSubject('120363000000000000@g.us', 'New Group Name')
```

### Alterar a Descrição

```js
await client.changeGroupDescription('120363000000000000@g.us', 'This is the group description')
```

### Alterar as Configurações

```js
// setting: 'edit_group_info' | 'send_messages' | 'add_participants' | 'approve_participants'
// policy:  'admins' | 'all'

await client.changeGroupSetting('120363000000000000@g.us', 'send_messages',   'admins')
await client.changeGroupSetting('120363000000000000@g.us', 'edit_group_info', 'admins')
await client.changeGroupSetting('120363000000000000@g.us', 'add_participants', 'all')
```

### Sair de um Grupo

```js
await client.leaveGroup('120363000000000000@g.us')
```

### Obter o Código de Convite

```js
const link = await client.queryGroupInviteLink('120363000000000000@g.us')
// e.g. 'https://chat.whatsapp.com/AbCdEfGhIjK'
console.log(link)
```

### Revogar o Código de Convite

```js
await client.revokeGroupInvite('120363000000000000@g.us')
```

### Entrar Usando o Código de Convite

> [!NOTE]
> Passe apenas a parte do código — não inclua `https://chat.whatsapp.com/`

```js
const jid = await client.acceptGroupInvite('AbCdEfGhIjK')
console.log('joined', jid)
```

### Consultar Informações do Convite pelo Link

Busca os metadados de um grupo a partir de um código de convite ou URL completa **sem** entrar no grupo. Útil para exibir uma prévia ao usuário antes de ele confirmar.

```js
// bare code
const info = await client.queryGroupInviteInfo('AbCdEfGhIjKlMnOpQrStUv')

// or pass the full URL — the code is extracted automatically
const info = await client.queryGroupInviteInfo('https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv')

console.log(info)
// {
//   jid:          '120363000000000000@g.us',
//   subject:      'My Group',
//   creator:      '919634847671@s.whatsapp.net',
//   creation:     1705315800,   // Unix timestamp
//   description:  'Group description here',
//   participants: [
//     { jid: '919634847671@s.whatsapp.net', role: 'admin' },
//     { jid: '12345678901@s.whatsapp.net',  role: 'member' }
//   ]
// }
```

### Buscar Todos os Grupos

Retorna um array de objetos de metadados para cada grupo do qual você é membro. Cada objeto tem o mesmo formato do `getGroupMetadata`.

```js
const groups = await client.fetchAllGroups()
for (const g of groups) {
  console.log(g.jid, g.subject, g.participants.length + ' members')
}
```

### Consultar Metadados

```js
const meta = await client.getGroupMetadata('120363000000000000@g.us')
console.log(meta.subject, meta.participants.length + ' members')
```

```js
{
  jid:             '120363000000000000@g.us',
  subject:         'My Group',
  size:            57,            // the server's own count
  creation:        1705315800,
  creator:         '919634847671@s.whatsapp.net',
  subjectTime:     1705315900,
  subjectBy:       '919634847671@s.whatsapp.net',
  description:     'Group description here',
  descriptionId:   'DESC1',       // echoed back as `prev` on the next edit
  descriptionBy:   '919634847671@s.whatsapp.net',
  descriptionByPn: '919634847671@s.whatsapp.net',
  descriptionTime: 1705315950,
  ephemeral:       86400,         // 0 when disappearing messages are off
  onlyAdminsSend:  false,
  onlyAdminsEdit:  false,
  joinApprovalMode: true,         // new members need an admin's approval
  memberAddMode:   'admin_add',   // 'admin_add' | 'all_member_add' | null
  isCommunity:         false,
  isCommunityAnnounce: false,
  defaultMembershipApprovalMode: null,   // communities only
  linkedParent:    null,          // the community this group belongs to
  isIncognito:     false,         // members' phone numbers hidden from each other
  isSuspended:     false,         // the group has been taken down
  notify:          'My Group',
  creatorPn:       '919634847671@s.whatsapp.net',
  creatorUsername: null,
  creatorCountry:  'IN',
  subjectByPn:     '919634847671@s.whatsapp.net',
  subjectByUsername: null,
  participantVersion: 'PV1',      // bumped when the member list changes
  announceVersion:    'AV1',      // bumped when the announce flag changes
  addressingMode:  'lid',         // 'lid' | 'pn'
  participants: [
    {
      jid:          '112713111982325@lid',
      role:         'admin',      // 'admin' | 'superadmin' | 'member'
      isAdmin:      true,
      isSuperAdmin: false,
      phoneNumber:  '919634847671@s.whatsapp.net',
      lid:          '112713111982325@lid',
      displayName:  null,
      username:     null
    }
  ]
}
```

Os dois endereços são preenchidos em cada participante, seja qual for a forma como o servidor
os nomeou, então você nunca precisa resolver um LID na mão para saber quem é alguém.

### Obter a Lista de Solicitações de Entrada

```js
const pending = await client.queryGroupPendingParticipants('120363000000000000@g.us')

for (const r of pending) {
  console.log(r.jid, 'asked at', new Date(r.requestedAt * 1000).toISOString())
}
```

Cada entrada é `{ jid, requestedAt }` — `requestedAt` é em segundos unix, ou `0` quando
o servidor não informou. Como nos resultados de participantes, uma entrada é convertida em string como o seu
JID.

### Aprovar / Recusar Solicitação de Entrada

O segundo parâmetro é um booleano: `true` para aprovar, `false` para recusar. O
valor de retorno é a mesma lista de resultados por participante que as chamadas de adicionar/remover
te dão.

```js
// approve join requests
const done = await client.approveGroupParticipants('120363000000000000@g.us', true, [
  '919634847671@s.whatsapp.net'
])
console.log(done.filter(r => !r.ok))   // whoever could not be let in, and why

// reject join requests
await client.approveGroupParticipants('120363000000000000@g.us', false, [
  '919634847671@s.whatsapp.net'
])
```

### Convites Pessoais

Um link de convite é público — qualquer pessoa que o tenha pode entrar. Um convite pessoal é
o outro tipo: emitido para uma pessoa específica, e é a única forma de entrar em um grupo para
alguém cujas configurações de privacidade impedem que seja adicionado diretamente.

Todo o fluxo começa com uma adição recusada. Quando o servidor recusa um participante
por esse motivo, ele devolve um código, que viaja até a pessoa como uma mensagem
na qual ela pode tocar.

```js
const groupJid = '120363000000000000@g.us'

// add whoever can be added, and invite whoever cannot — in one call
const results = await client.addGroupParticipantsOrInvite(groupJid, [
  '919634847671@s.whatsapp.net',
  '12345678901@s.whatsapp.net'
])

for (const r of results) {
  if (r.ok)              console.log('added', r.jid)
  else if (r.invited)    console.log('invited', r.jid)
  else                   console.log('failed', r.jid, r.status, r.inviteError || '')
}
```

Ou conduza você mesmo, se quiser decidir quem recebe um convite:

```js
const results = await client.addGroupParticipants(groupJid, [
  '919634847671@s.whatsapp.net'
])

for (const r of results.filter(x => x.needsInvite)) {
  await client.sendGroupInvite(r.jid, groupJid,
    r.addRequest.code, r.addRequest.expiration,
    { caption: 'Come join us' })
}
```

O `sendGroupInvite(to, groupJid, code, expiration, opts)` aceita
`{ groupName, caption, jpegThumbnail, isCommunity, id, contextInfo }`. O nome do grupo
é preenchido a partir dos metadados do próprio grupo quando você não fornece um.

No lado de quem recebe, um convite chega como um evento `message` comum cujo
`decoded.type` é `'groupInvite'`:
```js
client.on('message', async (msg) => {
  const d = msg.decoded
  if (!d || d.type !== 'groupInvite') return

  // look before you leap — this does not join anything
  const info = await client.queryGroupInviteMessageInfo(
    d.groupJid, msg.participant || msg.from, d.inviteCode, d.inviteExpiration)
  console.log(info.subject, info.size + ' members')

  // and accept it
  const jid = await client.acceptGroupInviteMessage(
    d.groupJid, msg.participant || msg.from, d.inviteCode, d.inviteExpiration)
  console.log('joined', jid)
})
```

Um convite decodificado carrega `{ groupJid, inviteCode, inviteExpiration,
groupName, jpegThumbnail, caption, isCommunity }`.

Para retirar um convite que você enviou antes que ele seja usado:

```js
await client.revokeGroupInviteForParticipant(groupJid, '919634847671')
```

Um convite expirado ou já usado lança erro em vez de resolver para nada,
então os dois casos são fáceis de distinguir.

### Alternar Mensagens Temporárias no Grupo

```js
await client.changeEphemeralTimer('120363000000000000@g.us', 86400)  // 1 day
await client.changeEphemeralTimer('120363000000000000@g.us', 0)      // off
```

## Comunidades

As Comunidades do WhatsApp são um superconjunto de grupos — um contêiner pai que pode conter vários
subgrupos vinculados mais um grupo de conversa geral automático.

### Criar uma Comunidade

```js
const community = await client.createCommunity('My Community', 'A place for discussion')
// community.jid  — e.g. 120363000000000001@g.us
```

### Desativar / Excluir uma Comunidade

```js
await client.deactivateCommunity('120363000000000001@g.us')
```

### Vincular Grupos a uma Comunidade

```js
const linked = await client.linkGroupsToCommunity(
  '120363000000000001@g.us',          // community JID
  ['120363000000000002@g.us',         // group JIDs to link
   '120363000000000003@g.us']
)
```

### Desvincular um Grupo de uma Comunidade

```js
await client.unlinkGroupFromCommunity(
  '120363000000000001@g.us',   // community JID
  '120363000000000002@g.us'    // group JID
)
```

## Newsletters (Canais)

As newsletters são canais de transmissão um-para-muitos.  Só o dono pode publicar; qualquer pessoa pode se inscrever.

### Criar uma Newsletter

```js
const nl = await client.createNewsletter('Tech News', 'Daily updates on tech')
// nl.jid — e.g. 120363000000000004@newsletter
```

### Entrar / Sair de uma Newsletter

```js
await client.joinNewsletter('120363000000000004@newsletter')
await client.leaveNewsletter('120363000000000004@newsletter')
```

### Consultar os Metadados da Newsletter

```js
const meta = await client.queryNewsletterMetadata('120363000000000004@newsletter')
// { jid, name, description, subscriberCount }
```

### Atualizar a Descrição da Newsletter

```js
await client.changeNewsletterDescription('120363000000000004@newsletter', 'New description here')
```

### Publicar uma Atualização de Texto na sua Newsletter

```js
await client.sendNewsletterText('120363000000000004@newsletter', 'Breaking: WhatsApp adds polls!')
```

## Perfil Comercial

Consulta o perfil comercial público de qualquer conta WhatsApp Business:

```js
const bp = await client.queryBusinessProfile('919634847671')
if (bp) {
  console.log(bp.category)     // e.g. "Software & IT Services"
  console.log(bp.email)        // business email (if set)
  console.log(bp.website)      // business website (if set)
  console.log(bp.address)      // physical address (if set)
  console.log(bp.description)  // business description (if set)
}
// Returns null if the number is not a WhatsApp Business account
```

---

## IDs do WhatsApp

- Contatos individuais: `[countrycode][number]@s.whatsapp.net`
  - Exemplo: `919634847671@s.whatsapp.net`
- Grupos: `[groupid]@g.us`
  - Exemplo: `120363000000000000@g.us`
- Transmissão de status: `status@broadcast`
- Listas de transmissão: `[timestamp]@broadcast`

> [!NOTE]
> Os números de telefone precisam incluir o código do país sem o prefixo `+`.

## Transporte

O whalibmob usa **Noise_XX_25519_AESGCM_SHA256** sobre TCP para `g.whatsapp.net:443`:

1. O cliente envia o `ClientHello` com uma chave pública X25519 efêmera.
2. O servidor responde com o `ServerHello` (efêmera + estática criptografada + payload).
3. Três passos DH (EE, SE, SS) derivam as chaves finais da sessão.
4. O cliente envia o `ClientFinish` (estática criptografada + payload criptografado).
5. A biblioteca espera por uma stanza `<success>` antes de emitir `connected`, ou por `<failure>` para o `auth_failure`.

A reconexão automática usa backoff exponencial:

| Tentativa | Espera |
|---|---|
| 1 | 1 s |
| 2 | 2 s |
| 3 | 4 s |
| 4 | 8 s |
| 5 | 15 s |
| 6+ | 30 s |

## Criptografia de Mídia

### Envio (Fluxo de Upload)

1. Uma **chave de mídia** aleatória de 32 bytes é gerada.
2. O HKDF-SHA256 a expande em IV (16 bytes), chave de cifra (32 bytes) e chave de MAC (32 bytes).
3. O arquivo é criptografado com **AES-256-CBC**.
4. Um MAC **HMAC-SHA256** de 10 bytes é anexado ao texto cifrado.
5. O blob criptografado é enviado ao CDN do WhatsApp.
6. A chave de mídia e a URL do CDN são embutidas no envelope de mensagem criptografado com Signal enviado ao destinatário.

### Recebimento (Fluxo de Download + Descriptografia)

Quando você recebe uma mensagem de mídia, o `msg.decoded` contém:
- `url` — o link HTTPS do CDN para baixar o blob criptografado
- `mediaKey` — a chave de 32 bytes (como um `Buffer`) necessária para descriptografá-lo
- `directPath` — caminho no CDN (fallback quando a URL completa não está disponível)

O processo de descriptografia espelha o de upload:

| Passo | Operação |
|---|---|
| 1 | Baixar o blob criptografado da URL do CDN |
| 2 | HKDF-SHA256(`mediaKey`, `""`, `"WhatsApp <Type> Keys"`, 112) → material de chave expandido |
| 3 | Dividir: `[0:16]` = IV · `[16:48]` = chave de cifra AES · `[48:80]` = chave HMAC |
| 4 | Verificar: `HMAC-SHA256(macKey, IV ∥ ciphertext)[:10]` precisa ser igual aos últimos 10 bytes do blob |
| 5 | Descriptografar: `AES-256-CBC(cipherKey, IV, ciphertext)` — remova os últimos 10 bytes primeiro |

Strings de info do HKDF:

| Tipo de mídia | String de info |
|---|---|
| `image` / `sticker` | `WhatsApp Image Keys` |
| `video` | `WhatsApp Video Keys` |
| `audio` / `voice` | `WhatsApp Audio Keys` |
| `document` | `WhatsApp Document Keys` |

Veja a seção [Recebendo Mídia](#recebendo-mídia) para um exemplo de código completo e funcional.

## Emulação de Dispositivo

O whalibmob consegue emular qualquer dispositivo iOS ou Android ao se comunicar com os servidores do WhatsApp.
O perfil de dispositivo controla o cabeçalho User-Agent, o campo `platform` do Protocolo Noise, e o token estático usado no cálculo do token de registro.

A configuração é feita inteiramente por variáveis de ambiente — nenhuma mudança de código é necessária.
Copie o `.env.example` para `.env` na raiz do seu projeto e defina as variáveis de que precisa.

### Início Rápido de Dispositivo

Emule um Android Pixel 8 Pro. **A sintaxe para definir uma variável muda de acordo com o
shell**, e errar isso é o motivo mais comum de um perfil de dispositivo parecer
ter sido ignorado:

**Linux, macOS, Termux** — defina-as para o comando específico:

```sh
WA_OS=android WA_DEVICE=pixel_8_pro node your-app.js
WA_OS=android WA_DEVICE=pixel_8_pro wa registration --request-code 919634847671
```

**Windows, Prompt de Comando** — `set` primeiro, um por linha. `VAR=value` na frente de
um comando é sintaxe Unix e o Windows responde com
`'WA_OS' is not recognized as an internal or external command`:

```bat
set WA_OS=android
set WA_DEVICE=pixel_8_pro
wa registration --request-code 919634847671
```

Mantenha-os em linhas separadas. Encadear com `&&` coloca o espaço antes do `&&`
dentro do valor.

**Windows, PowerShell**:

```powershell
$env:WA_OS = "android"
$env:WA_DEVICE = "pixel_8_pro"
wa registration --request-code 919634847671
```

**Em qualquer lugar, e a opção que vale a pena preferir** — um arquivo `.env` no diretório de onde você
executa, que se comporta de forma idêntica em toda plataforma:

```dotenv
WA_OS=android
WA_DEVICE=pixel_8_pro
```

```sh
wa registration --request-code 919634847671
```

A CLI lê o `.env` do **diretório atual**, e não de onde o whalibmob está
instalado, então faça `cd` para o diretório que o contém antes de executar. Seja qual for o jeito
que você escolher, a primeira linha da saída de `--debug` te diz se funcionou:
`User-Agent: WhatsApp/… Android/14 Device/Google-Pixel 8 Pro`. Um `iOS/…` ali
significa que as variáveis nunca chegaram.

Ou coloque as variáveis em um arquivo `.env`. Ao usar a **CLI** (comando `wa`) o arquivo é carregado automaticamente. Ao usar a **biblioteca diretamente**, carregue-o antes do `require('whalibmob')`:

```js
require('dotenv').config()          // must be first
const { WhalibmobClient } = require('whalibmob')
```

```dotenv
WA_OS=android
WA_DEVICE=pixel_8_pro
```

Emule um dispositivo Samsung personalizado:

```dotenv
WA_OS=android
WA_DEVICE_MODEL=SM-S928B
WA_DEVICE_MANUFACTURER=samsung
WA_DEVICE_OS_VERSION=14
WA_DEVICE_BUILD=UP1A.231005.007
WA_DEVICE_MODEL_ID=samsung-sm-s928b
```

### Perfis iOS

Valores disponíveis para `WA_DEVICE` quando `WA_OS=ios` (padrão):

| Chave do perfil | Dispositivo | Versão do iOS |
|---|---|---|
| `iphone_15_pro` | iPhone 15 Pro | 17.4.1 |
| `iphone_15` | iPhone 15 | 17.4.1 |
| `iphone_14_pro` | iPhone 14 Pro | 16.7.5 |
| `iphone_14` | iPhone 14 | 16.7.5 |
| `iphone_13_pro` | iPhone 13 Pro | 16.7.5 |
| `iphone_13` | iPhone 13 | 16.7.5 |
| `iphone_12_pro` | iPhone 12 Pro | 15.8.2 |
| `iphone_12` | iPhone 12 | 15.8.2 |
| `iphone_11_pro` | iPhone 11 Pro | 15.8.2 |
| `iphone_11` | iPhone 11 | 15.8.2 |
| `iphone_se3` | iPhone SE (3ª geração) | 16.7.5 |
| `iphone_xs` | iPhone Xs | 15.8.2 |

Formato do User-Agent do iOS: `WhatsApp/<version> iOS/<osVersion> Device/<model>`

### Perfis Android

Valores disponíveis para `WA_DEVICE` quando `WA_OS=android`:

| Chave do perfil | Dispositivo | Versão do Android |
|---|---|---|
| `pixel_8_pro` | Pixel 8 Pro | 14 |
| `pixel_8` | Pixel 8 | 14 |
| `pixel_7` | Pixel 7 | 14 |
| `pixel_7a` | Pixel 7a | 14 |
| `samsung_s24_ultra` | Samsung Galaxy S24 Ultra | 14 |
| `samsung_s24` | Samsung Galaxy S24 | 14 |
| `samsung_s23_ultra` | Samsung Galaxy S23 Ultra | 14 |
| `samsung_s23` | Samsung Galaxy S23 | 14 |
| `samsung_a55` | Samsung Galaxy A55 | 14 |
| `oneplus_12` | OnePlus 12 | 14 |
| `oneplus_11` | OnePlus 11 | 13 |
| `xiaomi_14` | Xiaomi 14 | 14 |
| `xiaomi_13` | Xiaomi 13 | 13 |
| `oppo_find_x7` | OPPO Find X7 | 14 |
| `realme_gt5` | realme GT 5 Pro | 14 |

Formato do User-Agent do Android: `WhatsApp/<version> A`

A versão do Android é buscada automaticamente na Google Play Store no primeiro uso e mantida em cache na memória. Se a busca falhar, o `ANDROID_VERSION_FALLBACK` é usado.

### Campos Personalizados de Dispositivo

Estas variáveis sobrescrevem campos individuais por cima do perfil selecionado:

| Variável | Descrição |
|---|---|
| `WA_DEVICE_MODEL` | String do modelo do dispositivo (ex.: `SM-S928B`) |
| `WA_DEVICE_MANUFACTURER` | Nome do fabricante (ex.: `samsung`) |
| `WA_DEVICE_OS_VERSION` | String da versão do SO (ex.: `14`) |
| `WA_DEVICE_BUILD` | Fingerprint da build (ex.: `UP1A.231005.007`) |
| `WA_DEVICE_MODEL_ID` | Slug do ID do modelo (ex.: `samsung-sm-s928b`) |

### Sobrescritas de Versão e Token

| Variável | Descrição |
|---|---|
| `WA_VERSION` | Fixa a versão do WhatsApp (ex.: `2.24.13.80`). Pula a busca ao vivo na loja, e é anunciada na conexão **no lugar da versão armazenada na sessão**. A CLI também a lê de um arquivo `.env` no diretório de trabalho, então uma deixada ali é anunciada por toda conexão feita a partir daquele diretório — que é como uma sessão funcional começa a ser recusada com [405](#quando-o-servidor-responde-405-na-conexão). Fixe-a deliberadamente e remova-a quando terminar. |
| `WA_STATIC_TOKEN` | Sobrescreve o token estático usado no cálculo do token de registro. Somente iOS — o Android não tem token estático. Sobrescreve tanto a constante do consumidor quanto a do Business. |
| `WA_BUSINESS` | Registra e conecta como WhatsApp Business (`1`/`true`/`yes`/`on`). Decide a plataforma anunciada, o User-Agent, de qual APK vem o material do token, e o certificado `vname`. Veja [Registrando uma conta WhatsApp Business](#registrando-uma-conta-whatsapp-business). |

### Quando o servidor responde 405 na conexão

```
WhatsApp auth failure 405 — client outdated. The server refused the version
this connect announced, which was 2.24.10.75. That value came from WA_VERSION
in the environment — the CLI also reads it out of a .env file in the directory
it runs from — while the session itself holds 2.26.29.73.
```

**A sessão está bem e o número continua registrado.** O 405 é o servidor
recusando o *cliente*, não a conta: a versão que está sendo anunciada não é uma
que ele aceita. Registrar o número de novo é a única atitude que não pode ajudar — a
mesma versão sairia e seria recusada de forma idêntica, ao custo de um número de telefone
real e de uma solicitação de código.

A conexão anuncia exatamente uma versão, e só existem dois lugares de onde ela pode
vir:

| ordem | de onde vem a versão anunciada |
|---|---|
| 1 | `WA_VERSION`, do shell **ou de um arquivo `.env` no diretório em que o comando roda** |
| 2 | a versão armazenada no arquivo de sessão — atualizada a partir da loja da plataforma antes de cada handshake, a menos que `{ refreshVersion: false }` |

Quase todo 405 é a primeira linha vencendo sem que ninguém tenha pretendido isso.

#### Confira o `WA_VERSION` antes de qualquer coisa

A CLI carrega o `.env` do diretório de trabalho antes de fazer qualquer outra coisa, então
um `WA_VERSION` deixado nesse arquivo é anunciado por *toda* conexão iniciada a partir
daquele diretório — no lugar da versão com que a sessão foi registrada, que o
servidor teria aceitado. Nada na sessão muda, então a falha
parece uma conta morta sem ser uma.

```sh
grep -i wa_version .env ~/.env
env | grep WA_VERSION
```

Remova ou comente a linha, e conecte de novo. Desde a 5.12.17 você não precisa
sair procurando: a CLI avisa antes de conectar,

```
warning: WA_VERSION=2.24.10.75 is pinned (shell or .env in /home/you) —
connecting announces it instead of the version stored in the session.
```

e um 405 nomeia a versão que saiu e de qual dos dois lugares ela veio,
porque é isso que decide o remédio — remover a sobrescrita, ou fixar uma mais nova.

Fixe o `WA_VERSION` de forma deliberada e temporária, para forçar uma build específica:

```sh
WA_VERSION=2.26.30.3 wa connect 919634847671
```

Deixá-lo no `.env` significa que toda sessão naquela máquina o anuncia até o
dia em que ele fica desatualizado, venham essas sessões de onde vierem.

#### Mantendo a versão da própria sessão atualizada

Sem nenhuma sobrescrita, a sessão anuncia a versão com a qual foi registrada, e
cada plataforma descobre isso de um jeito:

| | como a versão é encontrada | o que acontece quando isso falha |
|---|---|---|
| iOS | consultada na App Store | cai para uma versão compilada dentro da biblioteca, que fica desatualizada |
| Android | lida do APK de onde veio o material do token de registro | `wa apk-material --download` busca o atual |

**Essa versão é gravada uma única vez, no registro, e nada mais jamais mexe
nela.** Um número registrado hoje anuncia a versão de hoje também no ano que vem, e um
dia o servidor para de aceitá-la — um 405 sem nada de errado com a conta.
Atualizar o material do APK não alcança as sessões que já estão em disco.

O `wa refresh-version` é a parte que alcança:

```sh
wa apk-material --download        # Android: pick up the current APK first
wa refresh-version 5568936182750  # then write its version into the session
```

```
+5568936182750  android       2.24.10.75  →  2.26.30.5

  1 session(s) updated
  read from the APK the token material came from.
  reconnect for it to be announced.
```

Ele mexe no `version` e em mais nada — as chaves, o perfil de dispositivo e o
registro ficam exatamente como estavam — e nunca leva uma sessão
para trás. A loja da qual ele lê pode estar atrás do que uma sessão já tem,
já que a Play entrega a build correspondente ao perfil de dispositivo com que foi consultada, e não
a mais nova da listagem, e anunciar uma versão mais antiga é o único
resultado que torna um 405 mais provável:

```
+40756218532  android       2.26.30.3  (kept — newer than the 2.26.29.73 available)
``` O `--all` faz isso em toda sessão do
diretório de sessões, que é o que cabe em um cron mensal para um bot que
deve ficar de pé:

```sh
wa apk-material --download && wa refresh-version --all
```

`--version 2.26.30.5` grava uma versão que você indica em vez de consultar uma. E se
o `WA_VERSION` estiver definido, o comando avisa — a sobrescrita mascararia o que ele
gravar.

Pelo Node, a mesma coisa:

```js
const { refreshSessionVersion, currentVersionFor, storeFileFor } = require('whalibmob')

const base = path.join(process.env.HOME, '.waSession')
await refreshSessionVersion(storeFileFor(base, '5568936182750'))
await currentVersionFor({ os: 'android' })   // { version, source }
```

#### Se toda sessão Android for recusada, seja qual for a versão

Então é a biblioteca, e não a versão — atualize-a. Até a 5.12.15 os perfis de
dispositivo Android anunciavam a plataforma `3`, que é BlackBerry, um cliente que o WhatsApp
parou de construir em 2017. O servidor valida a versão anunciada do app
*contra a plataforma com a qual ela foi anunciada*, então uma build Android atual chegava
parecendo uma build BlackBerry impossível, e nada na falha nomeava a
plataforma. O iOS anunciava `1` e nunca foi afetado.

As sessões escritas antes da correção se consertam sozinhas na próxima vez que são carregadas
— a plataforma é derivada do `os` do perfil em vez de ser confiada ao arquivo —
então nada precisa ser registrado de novo.

Outro campo no mesmo payload estava errado, e não apenas incomum:
o `connectType` enviava `3` em toda reconexão, e o enum não tem `3` — os valores
válidos são `0` (celular, rádio desconhecido), `1` (wifi) e `100`–`112` para os
rádios celulares nomeados. Agora ele envia `1`.

Nada mais no payload mudou. Outros clientes não anunciam operadora
(`mcc`/`mnc` como `000`) e usam `en`/`US` independentemente do número; esta biblioteca
anuncia a operadora e o locale aos quais o número realmente pertence, e uma sessão ao vivo
foi testada contra o servidor das duas formas — nenhuma é recusada. `000/000`
é o que um aparelho sem SIM reporta, então um número com uma operadora por trás
dizendo isso é a coisa mais comum de se ser.

### Descobrindo a que o 405 se opõe

Quando a versão está certa e a conexão continua sendo recusada, pare de adivinhar:
o `tools/diagnose-405.js` roda o login uma vez por variação de payload e imprime
o que o servidor respondeu em cada uma.

```sh
node tools/diagnose-405.js 5568936182750

# installed globally:
node $(npm root -g)/whalibmob/tools/diagnose-405.js 5568936182750
```

```
what this library sends           ok — LOGIN ACCEPTED
  without the carrier (000/000)   ok — LOGIN ACCEPTED
  without the locale (en/US)      ok — LOGIN ACCEPTED
```

`405` significa que aquela linha foi recusada, `401` significa que o cliente foi aceito e só
as credenciais falharam, `ok` significa que o login passou. A primeira linha é o que
uma conexão real coloca na rede, e cada linha depois dela muda exatamente um
campo, então uma linha que se comporta de forma diferente da primeira nomeia o campo a que o
servidor se opôs. Toda linha usa a sessão que já está em disco: nada é
registrado, nenhum código é solicitado, e a sessão nunca é gravada.
O `--dry-run` imprime os tamanhos do payload sem abrir um socket.

**Se a primeira linha é aceita enquanto o `wa connect` é recusado, o payload não é
o problema.** A diferença está então no que a CLI lê e esta ferramenta não —
o `WA_VERSION`, do `.env`. Volte para o início desta seção.

## Licença

MIT
