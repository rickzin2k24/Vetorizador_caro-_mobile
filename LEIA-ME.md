# CAROÁ Vetoriza · app do celular

App para vetorizar **linhas de lote no celular, sem internet**.

- Ele não tem nenhum dado.
- O pedaço do ortomosaico e as linhas chegam pelo QR code do computador (aba **Lotes → 📱 Área para o celular**) e ficam guardados só no celular.

## Publicar no GitHub Pages (uma vez só, pelo navegador, sem instalar nada)

1. Entre no github.com com a sua conta → **New repository**.
   - Nome: `caroa-celular`.
   - **Public** (é o que dá o Pages grátis; aqui só tem programa, nenhum dado).
   - **Create repository**.
2. Na página do repositório, clique em **uploading an existing file**.
   - Arraste **tudo o que está dentro desta pasta** (`app-celular`): `index.html`, `app.js`, `app.css`, `sw.js`, `manifest.webmanifest`, `LEIA-ME.md`, a pasta `icones` e a pasta `vendor`.
   - Clique em **Commit changes**.
3. Vá em **Settings → Pages**.
   - Em *Build and deployment*: Source **Deploy from a branch**, Branch **main** e pasta **/ (root)**.
   - Clique em **Save**.
4. Espere 1 ou 2 minutos e recarregue a página do Settings → Pages. Aparece o link, assim: `https://SEU-USUARIO.github.io/caroa-celular/`.

## Instalar no iPhone

1. Abra o link no **Safari**.
2. Toque em **Compartilhar** (o quadrado com a seta) → **Adicionar à Tela de Início** → **Adicionar**.
3. Abra sempre pelo **ícone da Caroá** na tela de início.
   - É ele que funciona sem internet.
   - As áreas que você baixa pelo ícone ficam no ícone; se abrir pelo Safari, ele não enxerga essas áreas.
4. Na primeira leitura de QR, o iPhone pede a **câmera**: toque em **Permitir**.

## Usar

| Onde | O que fazer |
|---|---|
| Computador | Aba **Lotes** → **📱 Área para o celular** → contorne poucas quadras (o tamanho aparece embaixo do mapa) → botão direito fecha → **Gerar e mostrar o QR code**. |
| Celular | **📷 Escanear QR code** → aponte para a tela. Ele baixa a área e abre o mapa. Pode estar no Wi-Fi ou no 4G. |
| Celular, longe | Vetorize à vontade, até no modo avião. |
| Na volta | Computador: **📥 Receber do celular** (aparece um QR). Celular: abra a área → **⇪** → **Enviar pelo QR code**. |

Se não der para usar o QR na volta:
1. No celular: **⇪ → Exportar arquivo** e mande pelo WhatsApp ou e-mail.
2. No computador: **📥 Receber do celular → Escolher arquivo do celular**.

### Ferramentas no mapa

- **✋ Selecionar**: toque numa linha.
  - Arraste as bolinhas; aparece uma lupa em cima do dedo.
  - Arrastar o meio de um trecho cria um ponto.
- Com a linha selecionada:
  - **🗑 Apagar linha**;
  - **• Apagar ponto**: depois toque na bolinha;
  - **✂ Cortar**: depois toque onde quer cortar;
  - **⧉ Juntar**: depois toque na outra linha, com as pontas até 2 m uma da outra.
- **✏️ Linha**: toque os pontos no eixo do muro → **✓ Terminar**.
  - **↩ Ponto** tira o último ponto.
  - O ponto gruda nas linhas e nos cantos.
- **↶ Desfazer / ↷ Refazer**.
- **◎ GPS**, **👁 só a foto**, **⤢ ver a área toda**.
- **🎨 Linhas: grossura e cor**:
  - grossura de 0,3 a 14 px: botões *Bem fina … Bem grossa* e **− / +** para o ajuste fino;
  - borda preta (sem, fina ou grossa);
  - opacidade;
  - tamanho das bolinhas dos pontos;
  - cor de cada tipo de linha;
  - linhas da equipe tracejadas.

  O mapa muda na hora e fica guardado no celular. Para desfazer, **Voltar ao padrão**.

Cores no mapa:
- amarelo: linhas da equipe;
- verde: linhas do app;
- rosa: o que você mexeu e ainda não enviou.

## Atualizar o app

Quando vier uma versão nova:
1. Suba os arquivos de novo no mesmo repositório (**Add file → Upload files**, mesmos nomes) → **Commit**.
2. No iPhone, abra o app duas vezes: na segunda ele já está atualizado.

As áreas guardadas no celular não se perdem.

---

Bibliotecas usadas:
- OpenLayers (BSD-2): `vendor/ol-LICENSE.md`;
- jsQR (Apache-2.0): `vendor/jsQR-LICENSE.txt`.
