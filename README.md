# SisRoe: Sistema de Registro de Ocorrências Escolares (versão site)

Site para registrar e acompanhar ocorrências escolares, hospedado de graça no **GitHub Pages**, com banco de dados, login e tempo real no **Supabase** (plano gratuito). Não precisa instalar nada nos computadores da escola: basta um navegador.

## Como funciona

| Peça | Onde fica | Para quê |
|---|---|---|
| Site (HTML, CSS, JavaScript) | GitHub Pages | Telas que a equipe usa |
| Banco PostgreSQL | Supabase | Ocorrências, conversas, avisos, auditoria |
| Login e verificação em duas etapas | Supabase Auth | E-mail, senha e código do aplicativo autenticador |
| Avisos e chat em tempo real | Supabase Realtime | Ocorrências e mensagens aparecem na hora |
| PDFs | Navegador (jsPDF) | Ficha para prontuário e relatório geral |

A segurança fica **dentro do banco** (regras de acesso por linha, no `supabase/schema.sql`). Mesmo que alguém altere o site, o banco só entrega a cada pessoa o que o perfil dela permite.

### Quem pode o quê

| | AOE / Professor | Coordenação | Direção |
|---|---|---|---|
| Registrar ocorrência | Sim | Sim | Sim |
| Ver ocorrências | Só as próprias | Todas | Todas |
| Conversar na ocorrência | Nas próprias | Todas | Todas |
| Atualizar situação e providências | Não | Sim | Sim |
| PDF, relatórios e painel | Não | Sim | Sim |
| Usuários, configurações e auditoria | Não | Não | Sim |

## Colocar no ar (cerca de 20 minutos)

### 1. Criar o banco no Supabase

1. Crie uma conta gratuita em https://supabase.com e clique em **New project**.
2. Em **Region**, escolha **South America (São Paulo)**, para os dados ficarem no Brasil.
3. Com o projeto pronto, abra **SQL Editor > New query**, cole todo o conteúdo de `supabase/schema.sql` e clique em **Run**. Deve aparecer "Success".
4. Em **Authentication > Sign In / Providers > Email**, **desligue "Confirm email"** e salve. Isso é necessário porque a Direção cadastra a equipe pelo próprio sistema, e o envio de e-mails do plano gratuito é restrito. Deixe "Allow new users to sign up" ligado.

### 2. Criar o primeiro acesso da Direção

1. Em **Authentication > Users > Add user > Create new user**, informe o seu e-mail e uma senha, marque **Auto Confirm User** e crie.
2. No **SQL Editor**, rode (trocando o e-mail e o nome):

```sql
update public.perfis
set perfil = 'DIRECAO', nome = 'Seu Nome'
where email = 'seu.email@exemplo.com';
```

### 3. Publicar o site no GitHub

1. Crie uma conta em https://github.com e um repositório novo, por exemplo `sisroe`. No plano gratuito, o GitHub Pages exige repositório **público**. Isso não expõe dados: o código não contém nenhuma informação de estudantes nem senhas.
2. No repositório, clique em **Add file > Upload files** e envie todos os arquivos desta pasta (incluindo a pasta `supabase` e o arquivo `.nojekyll`).
3. No Supabase, abra **Project Settings > API Keys** e copie a **Project URL** e a chave **anon** (ou **publishable**). Nunca use a chave **service_role** / **secret**.
4. No GitHub, abra o arquivo `config.js`, clique no lápis para editar, cole os dois valores e salve com **Commit changes**.
5. Em **Settings > Pages**, em **Source**, escolha **Deploy from a branch**, branch **main**, pasta **/ (root)**, e salve.
6. Em um ou dois minutos o site estará em `https://SEU-USUARIO.github.io/sisroe/`.
7. Volte ao Supabase em **Authentication > URL Configuration** e coloque esse endereço em **Site URL**.

### 4. Primeiro uso

1. Entre no site com o e-mail e a senha da Direção e ative a verificação em duas etapas com um aplicativo autenticador gratuito (Google Authenticator, Microsoft Authenticator ou Aegis).
2. Em **Configurações**, informe o nome e o endereço da escola (aparecem nos PDFs) e revise os tipos de ocorrência.
3. Em **Usuários**, cadastre a equipe. Cada pessoa recebe uma senha provisória, que aparece uma única vez e deve ser entregue pessoalmente. No primeiro acesso, a pessoa troca a senha e ativa o duplo fator.

## Atualizar o site

Qualquer arquivo editado no GitHub é publicado de novo automaticamente em cerca de um minuto. Se preferir usar o Git:

```bash
git clone https://github.com/SEU-USUARIO/sisroe.git
cd sisroe
# edite os arquivos
git add . && git commit -m "Ajuste" && git push
```

## Limites do plano gratuito

- **Pausa por inatividade:** o Supabase pausa projetos gratuitos que ficam cerca de uma semana sem acesso (por exemplo, nas férias). Para reativar, entre no painel do Supabase e clique em **Restore project**. Os dados não são perdidos.
- **Backup:** o plano gratuito não oferece cópias de segurança para baixar. Faça uma exportação periódica em **Database > Backups** (quando disponível) ou exporte as tabelas em CSV pelo **Table Editor**. Uma alternativa completa é o comando `pg_dump` com a string de conexão de **Project Settings > Database**.
- **Capacidade:** 500 MB de banco, suficiente para muitos anos de ocorrências de uma escola.

## Proteção de dados (LGPD)

O sistema guarda dados pessoais de crianças e adolescentes, que a LGPD (art. 14) trata com proteção reforçada.

- Valide o uso com a Direção e com a Diretoria de Ensino antes de colocar em produção, e informe as famílias conforme a orientação da rede.
- Mantenha a verificação em duas etapas obrigatória (padrão).
- Desative imediatamente o acesso de quem deixar a escola (Usuários > Desativar). O bloqueio vale na hora, mesmo para quem estiver conectado.
- Registre fatos, não opiniões. Os PDFs saem com aviso de uso restrito.
- Consulte a Auditoria periodicamente. Criações, atualizações, mensagens e mudanças de usuários são registradas pelo próprio banco; consultas e PDFs são registrados pelo site.

## Estrutura

```
index.html            página única (entrada + sistema)
app.js                telas e regras de uso
pdf.js                geração dos PDFs
style.css             visual
config.js             endereço e chave pública do Supabase (preencher)
supabase/schema.sql   banco: tabelas, regras de acesso, funções e tempo real
```

## Problemas comuns

- **"Falta configurar":** o `config.js` ainda está com os valores de exemplo.
- **"E-mail ou senha incorretos" para alguém recém-cadastrado:** confira se "Confirm email" está desligado no Supabase.
- **"Acesso aguardando liberação":** a Direção precisa escolher o perfil da pessoa em Usuários.
- **Perdeu o celular com o autenticador:** a Direção usa "Refazer duplo fator" em Usuários.
- **Esqueceu a senha:** a Direção usa "Nova senha" em Usuários.
- **Site não abre depois de muito tempo sem uso:** o projeto do Supabase foi pausado; reative no painel.
