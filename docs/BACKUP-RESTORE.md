# BACKUP-RESTORE — levar tudo para outra máquina

> O aplicativo é **local**: tudo fica na pasta `data\` (ao lado da pasta do aplicativo). Para mudar de máquina ou guardar uma cópia:
> **Configurações → Backup e Restauração**. Código: `src/backup.js` (regras) · `src/backup-api.js` (rotas) · `public/backup.js` (tela).

## Exportar
1. **Configurações → Backup e Restauração → Exportar tudo**.
2. Deixe marcado **Proteger backup com senha** (recomendado) e informe a senha duas vezes (mínimo de 10 caracteres).
   Opcional: **Incluir as senhas das conexões de banco** (só com senha no backup).
3. Escolha onde salvar. Sai **um arquivo**: `GerenciadorProjetos-Backup-AAAA-MM-DD.gpbackup`.

A senha do backup **não é guardada** em lugar nenhum: sem ela o arquivo não abre. Anote-a no seu gerenciador de senhas.

## Importar (outra máquina ou a mesma)
1. Instale/copie o aplicativo e abra (começa vazio).
2. **Configurações → Backup e Restauração → Importar backup** → escolha o `.gpbackup` → senha, se houver.
3. Confira o resumo (data do backup, quantidade de projetos, checklists, scripts, documentos, evidências, horas…) → **Importar**.
4. O aplicativo:
   - salva um **backup automático do estado atual** em `%LOCALAPPDATA%\GerenciadorProjetos\backups\antes-importacao-<data>.gpbackup`;
   - monta os dados novos numa pasta ao lado, confere cada arquivo e troca as pastas;
   - recarrega e **compara** com o backup (resultado: “0 diferenças”). Se algo falhar, **volta ao estado anterior** — nunca fica metade importada.
5. **Caminhos que não existem nesta máquina** (pasta do projeto, bases, Workspace…) aparecem em lista: “Escolher nova pasta…” troca o caminho
   e tudo o que estiver dentro dele. Os demais dados já estão restaurados.

A importação **substitui** todos os dados atuais (não mescla duas máquinas).

## O que entra
| Entra | Detalhe |
|---|---|
| Projetos e tudo dentro deles | ciclo, etapas, checklists, pendências herdadas, dependências, observações, bases, planilhas e configurações de importação, cronograma, correções, ambientes RM, contatos |
| Configurações | tipos de projeto, ciclos, estágios, checklists e itens (modelos), responsáveis, sistemas de origem, alertas, jornada e metas de horas, Workspace |
| Comunicações | modelos de e-mail, histórico dos e-mails gerados, imagens dos modelos |
| Documentos e Modelos | o cadastro **e uma cópia dos arquivos** (até 200 MB cada). Na máquina nova, se o caminho original não existir, o arquivo vai para `data\documentos\` |
| Scripts SQL | conteúdo, versões antigas (`.versoes`) e removidos |
| Evidências | arquivos do checklist (inclusive os removidos, que nunca são apagados) |
| Controle de horas | apontamentos, cronômetros, observações do dia e seus anexos |
| Conexões | cadastro (servidor, base, usuário…). Senha: veja abaixo |
| Auditoria | `audit.log` |

| Preferências da tela | tema, menu recolhido, largura da lateral, preferências do Workspace e do “executar script” |

**Não entra:** últimas pastas usadas nos seletores (são caminhos desta máquina), o adiamento do aviso de expediente, as cópias `.bak`
internas, a pasta de publicação de atualizações (escolha de novo na máquina nova) e a chave de publicação.

## Senhas das conexões
- No computador, as senhas ficam protegidas pela **DPAPI do Windows** — só abrem neste usuário, nesta máquina. Esse valor protegido **nunca** vai para o backup.
- **Com** “Incluir as senhas das conexões” (exige senha no backup): as senhas são abertas só em memória, vão **dentro do pacote cifrado** e,
  na importação, são protegidas de novo com a DPAPI da máquina nova. Nunca são gravadas em texto puro no disco.
- **Sem** a opção: depois de importar, o aplicativo lista as conexões que precisam da senha de novo (Configurações → Conexões).

## Segurança do arquivo
- O backup contém **todos** os seus dados (clientes, contatos, e-mails, horas). Trate-o como confidencial.
- Protegido por senha: o pacote inteiro é cifrado com **AES-256-GCM**, chave derivada da senha com **scrypt** (sal aleatório). Senha errada
  ou arquivo alterado: recusado com “Senha incorreta ou arquivo de backup corrompido”.
- Sem senha: é um ZIP comum (dá para abrir no Windows) — use só em local seguro.
- Integridade: o `manifest.json` interno traz versão do formato, data, contagens e o **SHA-256 de cada arquivo**. Qualquer divergência,
  arquivo faltando/sobrando, caminho estranho ou versão de formato mais nova → nada é importado e a mensagem diz o motivo.
- Backups automáticos (`antes-importacao-*`) ficam só neste computador; apague os antigos quando não precisar mais.

## Formato (para manutenção)
```
.gpbackup sem senha = ZIP:  manifest.json · data/projects.json · data/<pastas da aplicação> · documentos/<id>/<arquivo>
.gpbackup com senha = "GPBACKUP-ENC1\n" + tamanho do cabeçalho + cabeçalho JSON (scrypt N/r/p/sal, iv) + AES-256-GCM(ZIP acima) + tag
                       (o cabeçalho é autenticado junto: AAD)
manifest.json = { format: "GerenciadorProjetosBackup", version: 1, appVersion, createdAt, encrypted, includesCredentials,
                  sections: {projects, cycles, …}, documents: [...], files: [{ path, size, sha256 }] }
```
O manifesto também traz `appVersion` (versão do aplicativo que gerou) e `schemaVersion` (esquema dos dados). Formato novo (versão 2+) ou
dados de esquema mais novo que o aplicativo: recusado com mensagem clara (“atualize o aplicativo”). Backup de esquema **anterior**: importado
e migrado na hora (src/migrations.js), com a cópia `projects.json.antes-esquema-<n>.bak`. Tela: “Último backup” mostra data, arquivo e versão.
