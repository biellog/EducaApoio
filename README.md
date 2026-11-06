# EducaApoio: Registro e acompanhamento de ocorrências escolares

Site para registrar e acompanhar ocorrências escolares, hospedado de graça no **GitHub Pages**, com banco de dados, login e tempo real no **Supabase** (plano gratuito). Não precisa instalar nada nos computadores da escola: basta um navegador.

## Como funciona

| Peça | Onde fica | Para quê |
|---|---|---|
| Site (HTML, CSS, JavaScript) | GitHub Pages | Telas que a equipe usa |
| Banco PostgreSQL | Supabase | Ocorrências, conversas, avisos, auditoria |
| Entrada por código | Supabase Auth + seu provedor de e-mail | A pessoa digita o e-mail e entra com um código de 6 dígitos que chega nele. Sem senha. |
| Avisos e chat em tempo real | Supabase Realtime | Ocorrências e mensagens aparecem na hora |
| PDFs | Navegador (jsPDF) | Ficha para prontuário e relatório geral |

A segurança fica **dentro do banco** (regras de acesso por linha, no `supabase/schema.sql`). Mesmo que alguém altere o site, o banco só entrega a cada pessoa o que o perfil dela permite.

### Quem pode o quê: funções de acesso

Cada pessoa tem uma **função**, e a função define o que ela vê e faz. O sistema já vem com quatro:

| | Professor(a) / AOE | Coordenação | Direção |
|---|---|---|---|
| Registrar ocorrência | Sim | Sim | Sim |
| Ver ocorrências | Só as próprias | Todas | Todas |
| Conversar nas ocorrências | Sim | Sim | Sim |
| Atualizar situação e providências | Não | Sim | Sim |
| Painel, PDFs e relatórios | Não | Sim | Sim |
| Configurações e auditoria | Não | Não | Sim |
| Cadastrar pessoas e criar funções | Não | Não | Sim (exclusivo) |

Em **Funções de acesso**, a Direção cria novas funções (por exemplo, "Administrador", "Psicólogo(a)" ou "Secretaria") e marca o que cada uma pode: registrar, ver as ocorrências de todos, conversar, acompanhar, painel, relatórios, configurações e auditoria. Também escolhe quais categorias de ocorrência a função enxerga (Administrativa, Pedagógica e Conviva). As funções prontas, exceto a Direção, também podem ser editadas. A função Direção é fixa, para a escola nunca ficar sem quem administre.

As regras valem no banco de dados, não só na tela: mesmo que alguém mexa no site, o banco só entrega o que a função permite.

### Categorias de ocorrência

As ocorrências são agrupadas em categorias. O sistema começa com Administrativa, Pedagógica e Conviva. Em **Configurações**, a Direção cria novas categorias (por exemplo "Saúde" ou "Família"), escolhe quais funções enxergam cada uma e cadastra os tipos de ocorrência dentro dela. Categorias podem ser renomeadas e desativadas. Só as novas podem ser excluídas, e apenas quando não têm tipos.

### Excluir ocorrência

Só a Direção pode excluir uma ocorrência, pelo botão no fim da tela da ocorrência. O sistema pede o motivo e uma confirmação final, e apaga junto a conversa, a linha do tempo e os anexos. A exclusão não pode ser desfeita, mas fica registrada na Auditoria com quem apagou, quando, os dados principais da ocorrência e o motivo.

### Anexos: fotos e PDF

Cada ocorrência pode ter fotos e PDFs anexados (por exemplo, a foto de uma carteira quebrada), no registro ou depois, na tela da ocorrência. No celular, dá para tirar a foto na hora. As fotos são reduzidas automaticamente antes do envio, e cada arquivo pode ter até 10 MB. Os arquivos ficam num armazenamento privado: só quem pode ver a ocorrência consegue abri-los, e os links expiram em uma hora. O PDF para prontuário imprime as fotos numa página de anexos. Ocorrências encerradas não recebem novos anexos, e só a Direção pode excluir um anexo. Tudo fica registrado na auditoria.

### Conversa fechada nas ocorrências encerradas

Quando a ocorrência é encerrada, a conversa da equipe fica só para consulta e ninguém consegue enviar mensagens, nem pelo site nem direto no banco. Quem tem a permissão de acompanhar pode reabrir a ocorrência mudando a situação, e a conversa volta a funcionar.

## Colocar no ar (cerca de 30 minutos)

### 1. Criar o banco no Supabase

1. Crie uma conta gratuita em https://supabase.com e clique em **New project**.
2. Em **Region**, escolha **South America (São Paulo)**, para os dados ficarem no Brasil.
3. Com o projeto pronto, abra **SQL Editor > New query**, cole todo o conteúdo de `supabase/schema.sql` e clique em **Run**. Deve aparecer "Success".
4. Em **Authentication > Sign In / Providers > Email**, **desligue "Confirm email"** e salve. Isso é necessário porque a Direção cadastra a equipe pelo próprio sistema, e o envio de e-mails do plano gratuito é restrito. Deixe "Allow new users to sign up" ligado.

### 2. Configurar o envio dos códigos por e-mail (obrigatório)

O serviço de e-mail que vem com o Supabase só envia para os membros da sua equipe no Supabase e no máximo 2 e-mails por hora. Para a escola, é preciso ligar um provedor de e-mail próprio (SMTP). Há opções gratuitas:

- **Brevo** (brevo.com): crie a conta, valide o e-mail remetente e pegue os dados em *SMTP & API*. O plano gratuito permite algumas centenas de e-mails por dia (confira o limite atual no site), o que sobra para uma escola.
- **Gmail**: com verificação em duas etapas ativa na conta Google, crie uma *senha de app* em myaccount.google.com/apppasswords. Servidor `smtp.gmail.com`, porta `465`, usuário = o endereço do Gmail, senha = a senha de app.

Depois, no Supabase:

1. **Authentication > Emails > SMTP Settings**: ligue **Enable custom SMTP** e preencha remetente (por exemplo `EducaApoio <seu.email@...>`), servidor, porta, usuário e senha do provedor. Salve.
2. **Authentication > Emails > Templates > Magic Link**: troque o assunto e o texto pelo modelo abaixo. O `{{ .Token }}` é o que faz chegar um código em vez de um link.

   Assunto: `Seu código de acesso ao EducaApoio`

   ```html
   <h2>Código de acesso ao EducaApoio</h2>
   <p>Digite este código para entrar:</p>
   <p style="font-size:28px;font-weight:bold;letter-spacing:4px">{{ .Token }}</p>
   <p>Ele vale por 10 minutos. Se não foi você que pediu, ignore este e-mail.</p>
   ```

3. **Authentication > Sign In / Providers > Email**: em **Email OTP Expiration**, coloque `600` (10 minutos) e mantenha o tamanho do código em `6`. Salve.
4. **Authentication > Rate Limits**: em **Rate limit for sending emails**, suba para algo como `100` por hora, para não travar na entrada da equipe no começo do turno.

### 3. Criar o primeiro acesso da Direção

1. Em **Authentication > Users > Add user > Create new user**, informe o seu e-mail e uma senha qualquer (ela não será usada), marque **Auto Confirm User** e crie.
2. No **SQL Editor**, rode (trocando o e-mail e o nome):

```sql
update public.perfis
set funcao_id = (select id from public.funcoes where direcao), nome = 'Seu Nome'
where email = 'seu.email@exemplo.com';
```

### 4. Publicar o site no GitHub

1. Crie uma conta em https://github.com e um repositório novo, por exemplo `educaapoio`. No plano gratuito, o GitHub Pages exige repositório **público**. Isso não expõe dados: o código não contém nenhuma informação de estudantes nem senhas.
2. No repositório, clique em **Add file > Upload files** e envie todos os arquivos desta pasta (incluindo a pasta `supabase` e o arquivo `.nojekyll`).
3. No Supabase, abra **Project Settings > API Keys** e copie a **Project URL** e a chave **anon** (ou **publishable**). Nunca use a chave **service_role** / **secret**.
4. No GitHub, abra o arquivo `config.js`, clique no lápis para editar, cole os dois valores e salve com **Commit changes**.
5. Em **Settings > Pages**, em **Source**, escolha **Deploy from a branch**, branch **main**, pasta **/ (root)**, e salve.
6. Em um ou dois minutos o site estará em `https://SEU-USUARIO.github.io/educaapoio/`.
7. Volte ao Supabase em **Authentication > URL Configuration** e coloque esse endereço em **Site URL**.

### 5. Primeiro uso

1. Entre no site com o seu e-mail e o código que chegar nele.
2. Em **Configurações**, informe o nome e o endereço da escola (aparecem nos PDFs) e revise os tipos de ocorrência.
3. Se precisar, crie funções em **Funções de acesso**. Depois, em **Usuários**, cadastre a equipe com nome, e-mail e função. A pessoa já pode entrar: basta digitar o e-mail no site e usar o código recebido. Depois de cadastrar todos, desligue **Allow new users to sign up** em Authentication > Sign In / Providers > Email; ligue de novo só quando precisar cadastrar alguém.

## Já tinha o EducaApoio instalado?

Rode **uma vez** o arquivo `supabase/migracao-funcoes.sql` no SQL Editor. Ele serve para qualquer versão anterior (com autenticador ou já com código no e-mail): transforma os perfis antigos em funções, fecha o chat das ocorrências encerradas e mantém ocorrências, conversas, usuários e auditoria. No fim, ele mostra a lista de pessoas com a função de cada uma, para você conferir. Depois, atualize os arquivos do site no GitHub (sem trocar o seu `config.js`). Se vier da versão com autenticador, faça também a configuração de e-mail do passo 2.

## Atualizações do banco

Se o seu banco foi criado antes destas funções, rode **uma vez cada**, nesta ordem, os arquivos que ainda não rodou:

1. `supabase/migracao-funcoes.sql`: funções de acesso e chat fechado.
2. `supabase/migracao-anexos.sql`: fotos e PDF.
3. `supabase/migracao-exclusao-categorias.sql`: categorias configuráveis e exclusão de ocorrências.

Em instalações novas, o `schema.sql` já inclui tudo.

## Ativar os anexos (fotos e PDF)

Se o seu banco foi criado antes dos anexos, rode **uma vez** o arquivo `supabase/migracao-anexos.sql` no SQL Editor. Em instalações novas, o `schema.sql` já inclui os anexos.

## Atualizar o site

Qualquer arquivo editado no GitHub é publicado de novo automaticamente em cerca de um minuto. Se preferir usar o Git:

```bash
git clone https://github.com/SEU-USUARIO/educaapoio.git
cd educaapoio
# edite os arquivos
git add . && git commit -m "Ajuste" && git push
```

## Limites do plano gratuito

- **Pausa por inatividade:** o Supabase pausa projetos gratuitos que ficam cerca de uma semana sem acesso (por exemplo, nas férias). Para reativar, entre no painel do Supabase e clique em **Restore project**. Os dados não são perdidos.
- **Backup:** o plano gratuito não oferece cópias de segurança para baixar. Faça uma exportação periódica em **Database > Backups** (quando disponível) ou exporte as tabelas em CSV pelo **Table Editor**. Uma alternativa completa é o comando `pg_dump` com a string de conexão de **Project Settings > Database**.
- **Capacidade:** 500 MB de banco, suficiente para muitos anos de ocorrências de uma escola, e 1 GB para anexos. Como as fotos são reduzidas (cerca de 300 KB cada), cabem alguns milhares. O uso aparece em Supabase > Storage.

## Proteção de dados (LGPD)

O sistema guarda dados pessoais de crianças e adolescentes, que a LGPD (art. 14) trata com proteção reforçada.

- Valide o uso com a Direção e com a Diretoria de Ensino antes de colocar em produção, e informe as famílias conforme a orientação da rede.
- O e-mail é a chave de entrada: quem acessar a caixa de e-mail de alguém consegue entrar como essa pessoa. Oriente a equipe a proteger o e-mail (de preferência com verificação em duas etapas no próprio provedor de e-mail) e a não deixar o e-mail aberto em computadores compartilhados.
- Em computadores compartilhados, use sempre **Sair**. Em "Minha conta", cada pessoa pode encerrar o acesso em todos os aparelhos.
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
supabase/migracao-funcoes.sql   só para quem já tinha o EducaApoio instalado
supabase/migracao-anexos.sql    ativa os anexos em bancos já existentes
supabase/migracao-exclusao-categorias.sql   categorias configuráveis e exclusão
```

## Problemas comuns

- **"Falta configurar":** o `config.js` ainda está com os valores de exemplo.
- **O código não chega:** olhe a caixa de spam e confira se o e-mail foi digitado igual ao cadastrado. Se não chega para ninguém, revise o SMTP (passo 2); os erros de envio aparecem em Supabase > Logs > Auth.
- **"O envio de e-mails ainda não foi configurado":** falta ligar o SMTP próprio (passo 2).
- **"Limite de envio de e-mails atingido":** aumente o limite em Authentication > Rate Limits.
- **"Código inválido ou vencido":** o código vale 10 minutos e só pode ser usado uma vez. Peça outro.
- **"Acesso aguardando liberação":** a Direção precisa escolher a função da pessoa em Usuários.
- **Mudei uma função e nada mudou para a pessoa:** as permissões são lidas ao abrir o site. Peça para a pessoa atualizar a página (F5).
- **Não consigo excluir uma função:** ainda há pessoas com ela. Mude a função dessas pessoas em Usuários antes.
- **Site não abre depois de muito tempo sem uso:** o projeto do Supabase foi pausado; reative no painel.
