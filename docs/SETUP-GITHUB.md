# SETUP-GITHUB — o código no GitHub

> O GitHub guarda **só o código-fonte** (histórico, backup do código, desenvolvimento). **Nunca** dados da aplicação, segredos ou builds.
> Quem só usa o aplicativo não precisa de Git, Node nem GitHub. Dados vão de uma máquina para outra pelo **backup** ([BACKUP-RESTORE.md](BACKUP-RESTORE.md)).

## 1. O que NUNCA entra no Git
| Nunca | Proteção |
|---|---|
| `data/`, `projects.json*`, `audit.log`, `backups/`, `*.gpbackup` | `.gitignore` + `scan-secrets` |
| `.env`, chaves, certificados, `*.dpapi*` | `.gitignore` + `scan-secrets` |
| senhas, tokens do GitHub, connection strings com senha, blobs DPAPI | padrões do `scan-secrets` |
| nomes de clientes, contatos, e-mails, servidores reais (inclusive em testes e docs) | **canários**: o `scan-secrets` compara com os valores reais de `data/projects.json` |
| `app/`, `node_modules/`, `dist/` | `.gitignore` |
Testes usam nomes fictícios (`Cliente Alfa`, `192.0.2.x`, `@exemplo.test`).

## 2. Proteções locais
```bash
git config core.hooksPath .githooks
```
O hook `pre-commit` roda `node scripts/scan-secrets.js --staged` e barra o commit se achar segredo ou dado real. Conferir tudo:
```bash
npm run scan:secrets
```

## 3. Dia a dia
- Trabalho novo: `git switch -c feature/<nome>` → commits → push → Pull Request para `main`. Antes do PR: `npm test`.
- Outra máquina de desenvolvimento: `git clone` → `npm ci` → `npm test`. Autenticação pelo *Git Credential Manager* (sem token em arquivo).

## 4. Gerar o aplicativo
Com o aplicativo fechado: `npm run build:desktop` → `app\Gerenciador de Projetos.exe`. Versão nova para as outras máquinas:
`npm version patch --no-git-tag-version` → `npm run publicar -- --canal "<pasta>"` ([DISTRIBUICAO-ATUALIZACAO.md](DISTRIBUICAO-ATUALIZACAO.md)).
O GitHub não é usado para distribuir o aplicativo nem dados.

## 5. Recuperar
| Situação | Comando |
|---|---|
| Ver histórico | `git log --oneline --decorate -20` |
| Desfazer um commit já publicado | `git revert <hash>` (não reescreve histórico) |
| Se um segredo vazou | **primeiro** troque o segredo; depois limpe o histórico (`git filter-repo`) |
