# DISTRIBUIÇÃO, ATUALIZAÇÃO E CONFIGURAÇÕES COMPARTILHADAS

> Três coisas diferentes, cada uma com seu mecanismo:
> | O quê | Leva | Como |
> |---|---|---|
> | **Atualização do aplicativo** | só o código (telas, CSS, funções) | pasta de publicação → Configurações → Atualizações → Atualizar |
> | **Configurações compartilháveis** | ciclos, checklists, scripts, modelos… | pasta de publicação → Configurações → Atualizações → Sincronizar |
> | **Backup pessoal** | TODOS os seus dados | arquivo `.gpbackup` → Configurações → Backup e Restauração ([BACKUP-RESTORE.md](BACKUP-RESTORE.md)) |
> Código: `src/channel.js` · `src/updates.js` · `src/config-sync.js` · `src/updates-api.js` · `src/migrations.js` · `public/updates.js` · `scripts/publicar.js`.

## Como a instalação é organizada
```
<pasta da instalação>\app\Gerenciador de Projetos.exe   runtime (Electron)          ← muda só com pacote de instalação completo
<pasta da instalação>\app\resources\app.asar             CÓDIGO do aplicativo        ← é o que a atualização troca
<pasta da instalação>\data\                              SEUS DADOS                  ← nunca tocados por atualização
<pasta da instalação>\atualizacoes\                      pacote baixado + resultado da última atualização
```
Na máquina nova não precisa de Node, Git, GitHub nem instalação: é extrair e abrir.

## Pasta de publicação (canal)
Qualquer pasta que as suas máquinas enxerguem: OneDrive/Google Drive sincronizado, pasta de rede ou pendrive. Escolha em
**Configurações → Atualizações → Pasta de publicação** (em cada máquina; o caminho pode ser diferente em cada uma).
```
canal.json                                         versão mais nova (assinada) + revisão das configurações
versoes\GerenciadorProjetos-<v>.gpupdate           atualização (~16 MB)
versoes\GerenciadorProjetos-<v>-instalacao.zip     instalação completa para máquina nova (~155 MB; fica só a mais nova)
configuracoes\configuracoes-r<N>.gpconfig          configurações compartilháveis
```
Nada de dados pessoais vai para a pasta (projetos, horas, conexões, contatos de projeto ficam de fora).

## Versão nova do aplicativo (qualquer computador com a pasta do canal)
1. Faça a alteração e rode `npm test`.
2. Aumente a versão (semver: correção `patch`, recurso `minor`, quebra `major`):
   ```bash
   npm version patch --no-git-tag-version
   ```
3. Com o aplicativo **fechado**, gere e publique:
   ```bash
   npm run publicar -- --canal "D:\OneDrive\GerenciadorProjetos-canal" --notas "o que mudou"
   ```
   O comando pede a **senha da chave de publicação** (ou use a variável `GP_CHAVE_SENHA`). Pasta ainda sem chave: acrescente
   `--nova-chave` (uma vez). (Ou: `npm run build:desktop`, abra o app e use **Configurações → Atualizações → Publicar esta versão**.)

A **chave de publicação** fica na própria pasta do canal (`chave-publicacao.json`): a parte privada vai cifrada com a sua senha
(scrypt + AES-256-GCM; a senha nunca é gravada). Assim qualquer computador com acesso à pasta publica, sem depender de uma máquina.
Cada pacote é assinado com ela; as instalações só aceitam atualização assinada pela chave em que confiam (a que veio no pacote de
instalação). Versão igual ou menor que a do canal é recusada.

**Chave nova** (primeira chave da pasta ou troca): instalações que confiavam em outra chave mostram “Confiar na nova chave” em
**Configurações → Atualizações** e pedem a mesma senha uma vez; sem a senha, nada muda. Quem consegue gravar na pasta, mas não sabe
a senha, não publica código nem faz as instalações trocarem de chave.

## Máquina nova
1. Copie `versoes\GerenciadorProjetos-<v>-instalacao.zip` da pasta de publicação e extraia numa pasta sua (ex.: `C:\GerenciadorProjetos`).
2. Abra `app\Gerenciador de Projetos.exe` — abre **vazio** (estrutura padrão).
3. **Configurações → Backup e Restauração → Importar backup** com o `.gpbackup` gerado na máquina principal.
4. **Configurações → Atualizações → Escolher pasta…** (a pasta de publicação) para receber as próximas versões.

## Atualizar (outra máquina)
Ao abrir, o aplicativo confere a pasta de publicação uma vez e avisa “Existe uma nova versão da aplicação disponível”.
**Configurações → Atualizações → Atualizar aplicação**:
1. backup automático dos dados (`%LOCALAPPDATA%\GerenciadorProjetos\backups\antes-atualizacao-*.gpbackup`);
2. copia o pacote, confere **SHA-256** e **assinatura**, extrai em `app\resources.nova` e confere o código de novo (o app segue funcionando);
3. o aplicativo fecha; um script fixo troca `resources` ↔ `resources.nova` (a anterior fica em `resources.anterior`) e reabre;
4. a versão nova avisa que subiu; **se não subir em 90 s, a anterior volta sozinha** e reabre. O resultado aparece na próxima abertura.
Se a versão nova usar outro Electron, a tela pede o pacote de instalação completo (extraia por cima da pasta `app\`; `data\` não é tocada).

## Migrações de dados
`projects.json` guarda `schemaVersion` e o histórico `migrations[]`. Versão que muda a estrutura acrescenta uma entrada em
`src/migrations.js`; ao abrir, só as pendentes rodam, em ordem, com cópia antes (`projects.json.antes-esquema-<n>.bak`). Dados de
versão MAIS NOVA que o aplicativo: o app não abre (nada é gravado) e pede atualização. Backup de versão anterior: migrado ao importar.

## Configurações compartilháveis
Publicar: **Configurações → Atualizações → Publicar configurações** (revisão + 1). Nas outras máquinas: **Verificar configurações** mostra
cada mudança e **Sincronizar** aplica (com backup automático antes):
| Situação | O que acontece |
|---|---|
| novo na origem | adicionado |
| atualizado na origem | substituído |
| alterado só aqui | mantido o daqui |
| alterado aqui e na origem | vale a origem (avisado antes) |
| removido na origem | mantido aqui (só avisa) |
| só existe aqui | intocado |
Entram: estágios, tipos de projeto, sistemas de origem, ciclos, checklists e itens, scripts SQL (com conteúdo), modelos de e-mail globais
(+ imagens), documentos e modelos (+ arquivo), alerta de prazo, regras de evidência e ciclo padrão. Ciclo cujos passos mudaram ganha
versão nova: os projetos mostram “nova versão do ciclo” e só mudam ao **Aplicar**.

## Limitações
- O executável não tem certificado de assinatura de código: o Windows pode avisar “editor desconhecido” na primeira abertura.
- Esqueceu a senha da chave? Ela não pode ser recuperada: apague `chave-publicacao.json` da pasta, publique com `--nova-chave` e
  reinstale as outras máquinas pelo pacote de instalação (sem a senha antiga, “Confiar na nova chave” não tem como provar a troca).
- Voltar manualmente para a versão anterior não tem botão: a anterior fica em `app\resources.anterior` (troca automática só quando a
  nova não sobe).
