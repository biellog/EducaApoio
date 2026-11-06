-- =====================================================================
-- SisRoe - Sistema de Registro de Ocorrências Escolares
-- Esquema do banco para o Supabase. Rode UMA VEZ no SQL Editor de um
-- projeto novo (Supabase > SQL Editor > New query > colar > Run).
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- Tabelas
-- ---------------------------------------------------------------------

create table public.configuracoes (
  id int primary key default 1 check (id = 1),
  escola_nome text not null default 'Unidade Escolar',
  escola_endereco text not null default '',
  exigir_2fa boolean not null default true,
  limite_atencao int not null default 3 check (limite_atencao between 1 and 100)
);
insert into public.configuracoes (id) values (1);

create table public.perfis (
  id uuid primary key references auth.users(id) on delete cascade,
  nome text not null,
  email text not null,
  perfil text check (perfil in ('AOE','PROFESSOR','COORDENACAO','DIRECAO')), -- nulo = aguardando liberação
  ativo boolean not null default true,
  trocar_senha boolean not null default false,
  criado_em timestamptz not null default now()
);

create table public.tipos_ocorrencia (
  id bigint generated always as identity primary key,
  nome text not null check (length(trim(nome)) between 1 and 80),
  categoria text not null check (categoria in ('ADMINISTRATIVA','PEDAGOGICA','CONVIVA')),
  ativo boolean not null default true,
  unique (nome, categoria)
);

create table public.ocorrencias (
  id bigint generated always as identity primary key,
  data_fato date not null,
  turma text not null check (length(trim(turma)) between 1 and 40),
  aluno text not null check (length(trim(aluno)) between 1 and 150),
  tipo_id bigint not null references public.tipos_ocorrencia(id),
  descricao text not null check (length(trim(descricao)) between 1 and 5000),
  providencias text not null check (length(trim(providencias)) between 1 and 3000),
  status text not null default 'ABERTA' check (status in ('ABERTA','EM_ACOMPANHAMENTO','ENCERRADA')),
  autor_id uuid not null default auth.uid() references public.perfis(id),
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index ocorrencias_aluno_idx on public.ocorrencias (lower(aluno));
create index ocorrencias_data_idx on public.ocorrencias (data_fato);
create index ocorrencias_autor_idx on public.ocorrencias (autor_id);

create table public.historico_status (
  id bigint generated always as identity primary key,
  ocorrencia_id bigint not null references public.ocorrencias(id),
  status text not null,
  observacao text,
  usuario_id uuid not null references public.perfis(id),
  criado_em timestamptz not null default now()
);
create index historico_oc_idx on public.historico_status (ocorrencia_id);

create table public.mensagens (
  id bigint generated always as identity primary key,
  ocorrencia_id bigint not null references public.ocorrencias(id),
  usuario_id uuid not null default auth.uid() references public.perfis(id),
  texto text not null check (length(trim(texto)) between 1 and 2000),
  criado_em timestamptz not null default now()
);
create index mensagens_oc_idx on public.mensagens (ocorrencia_id);

create table public.notificacoes (
  id bigint generated always as identity primary key,
  usuario_id uuid not null references public.perfis(id) on delete cascade,
  ocorrencia_id bigint references public.ocorrencias(id),
  texto text not null,
  lida boolean not null default false,
  criado_em timestamptz not null default now()
);
create index notificacoes_user_idx on public.notificacoes (usuario_id, lida);

create table public.auditoria (
  id bigint generated always as identity primary key,
  usuario_id uuid references public.perfis(id) on delete set null,
  acao text not null,
  entidade text,
  entidade_id text,
  detalhes jsonb,
  ip text,
  criado_em timestamptz not null default now()
);
create index auditoria_data_idx on public.auditoria (criado_em desc);

-- Tipos iniciais (a Direção ajusta na tela Configurações)
insert into public.tipos_ocorrencia (nome, categoria) values
  ('Atraso', 'ADMINISTRATIVA'),
  ('Saída antecipada', 'ADMINISTRATIVA'),
  ('Uso indevido de celular', 'ADMINISTRATIVA'),
  ('Dano ao patrimônio', 'ADMINISTRATIVA'),
  ('Não realização de atividades', 'PEDAGOGICA'),
  ('Indisciplina em sala de aula', 'PEDAGOGICA'),
  ('Falta de material', 'PEDAGOGICA'),
  ('Agressão verbal', 'CONVIVA'),
  ('Agressão física', 'CONVIVA'),
  ('Intimidação sistemática (bullying)', 'CONVIVA'),
  ('Ameaça', 'CONVIVA'),
  ('Discriminação', 'CONVIVA');

-- ---------------------------------------------------------------------
-- Funções de permissão (usadas pelas regras de acesso)
-- ---------------------------------------------------------------------

create or replace function public.meu_perfil() returns text
language sql stable security definer set search_path = public as $$
  select perfil from public.perfis where id = auth.uid() and ativo and perfil is not null
$$;

-- Liberado: tem perfil, está ativo e passou pelo duplo fator (quando exigido)
create or replace function public.acesso_ok() returns boolean
language sql stable security definer set search_path = public as $$
  select public.meu_perfil() is not null
     and (not (select exigir_2fa from public.configuracoes where id = 1)
          or coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2')
$$;

create or replace function public.e_gestor() returns boolean
language sql stable security definer set search_path = public as $$
  select public.acesso_ok() and public.meu_perfil() in ('COORDENACAO','DIRECAO')
$$;

create or replace function public.e_direcao() returns boolean
language sql stable security definer set search_path = public as $$
  select public.acesso_ok() and public.meu_perfil() = 'DIRECAO'
$$;

-- Quem registra (AOE/professor) vê o que registrou; Coordenação e Direção veem tudo
create or replace function public.pode_ver(p_autor uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.e_gestor() or (public.acesso_ok() and p_autor = auth.uid())
$$;

create or replace function public.ip_atual() returns text
language sql stable as $$
  select split_part(coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-forwarded-for', ''), ',', 1)
$$;

-- Uso interno: grava auditoria
create or replace function public.registrar(p_acao text, p_entidade text, p_id text, p_detalhes jsonb)
returns void language sql security definer set search_path = public as $$
  insert into public.auditoria (usuario_id, acao, entidade, entidade_id, detalhes, ip)
  values (auth.uid(), p_acao, p_entidade, p_id, p_detalhes, public.ip_atual());
$$;

-- Uso interno: avisa Coordenação, Direção e o autor (menos quem gerou o aviso)
create or replace function public.notificar(p_oc bigint, p_texto text, p_exceto uuid)
returns void language sql security definer set search_path = public as $$
  insert into public.notificacoes (usuario_id, ocorrencia_id, texto)
  select p.id, p_oc, p_texto
  from public.perfis p
  where p.ativo
    and p.id is distinct from p_exceto
    and (p.perfil in ('COORDENACAO','DIRECAO')
         or p.id = (select autor_id from public.ocorrencias where id = p_oc));
$$;

revoke execute on function public.registrar(text, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.notificar(bigint, text, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Gatilhos
-- ---------------------------------------------------------------------

-- Toda conta criada ganha um perfil "aguardando liberação"
create or replace function public.novo_usuario() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.perfis (id, nome, email)
  values (new.id,
          coalesce(nullif(trim(new.raw_user_meta_data ->> 'nome'), ''), split_part(new.email, '@', 1)),
          new.email);
  return new;
end $$;
create trigger ao_criar_usuario after insert on auth.users
  for each row execute function public.novo_usuario();

-- Validação de nova ocorrência
create or replace function public.validar_ocorrencia() returns trigger
language plpgsql set search_path = public as $$
begin
  new.autor_id := auth.uid();
  new.turma := trim(new.turma);
  new.aluno := trim(regexp_replace(new.aluno, '\s+', ' ', 'g'));
  new.descricao := trim(new.descricao);
  new.providencias := trim(new.providencias);
  new.criado_em := now();
  new.atualizado_em := now();
  if new.data_fato > (now() at time zone 'America/Sao_Paulo')::date then
    raise exception 'A data do fato não pode ser no futuro.';
  end if;
  if not exists (select 1 from public.tipos_ocorrencia where id = new.tipo_id and ativo) then
    raise exception 'Tipo de ocorrência inválido.';
  end if;
  return new;
end $$;
create trigger validar_ocorrencia before insert on public.ocorrencias
  for each row execute function public.validar_ocorrencia();

create or replace function public.apos_ocorrencia() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_tipo text; v_autor text;
begin
  select nome into v_tipo from public.tipos_ocorrencia where id = new.tipo_id;
  select nome into v_autor from public.perfis where id = new.autor_id;
  insert into public.historico_status (ocorrencia_id, status, observacao, usuario_id)
  values (new.id, new.status, 'Registro inicial', new.autor_id);
  perform public.notificar(new.id,
    format('Nova ocorrência: %s, %s (%s), por %s', v_tipo, new.aluno, new.turma, v_autor), new.autor_id);
  perform public.registrar('OCORRENCIA_CRIADA', 'ocorrencia', new.id::text,
    jsonb_build_object('aluno', new.aluno, 'turma', new.turma, 'tipo', v_tipo));
  return null;
end $$;
create trigger apos_ocorrencia after insert on public.ocorrencias
  for each row execute function public.apos_ocorrencia();

-- Mensagens do chat
create or replace function public.validar_mensagem() returns trigger
language plpgsql as $$
begin
  new.usuario_id := auth.uid();
  new.texto := trim(new.texto);
  new.criado_em := now();
  return new;
end $$;
create trigger validar_mensagem before insert on public.mensagens
  for each row execute function public.validar_mensagem();

create or replace function public.apos_mensagem() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_nome text; v_aluno text;
begin
  select nome into v_nome from public.perfis where id = new.usuario_id;
  select aluno into v_aluno from public.ocorrencias where id = new.ocorrencia_id;
  perform public.notificar(new.ocorrencia_id,
    format('%s comentou na ocorrência nº %s (%s)', v_nome, new.ocorrencia_id, v_aluno), new.usuario_id);
  perform public.registrar('MENSAGEM_ENVIADA', 'ocorrencia', new.ocorrencia_id::text, null);
  return null;
end $$;
create trigger apos_mensagem after insert on public.mensagens
  for each row execute function public.apos_mensagem();

-- Auditoria de mudanças em usuários, tipos e configurações
create or replace function public.auditar_perfis() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.perfil is distinct from old.perfil then
    perform public.registrar('USUARIO_PERFIL', 'usuario', new.id::text,
      jsonb_build_object('de', old.perfil, 'para', new.perfil));
  end if;
  if new.ativo is distinct from old.ativo then
    perform public.registrar(case when new.ativo then 'USUARIO_ATIVADO' else 'USUARIO_DESATIVADO' end,
      'usuario', new.id::text, null);
  end if;
  return new;
end $$;
create trigger auditar_perfis after update on public.perfis
  for each row execute function public.auditar_perfis();

create or replace function public.auditar_alteracao() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.registrar(tg_argv[0], tg_table_name, new.id::text, to_jsonb(new));
  return new;
end $$;
create trigger auditar_tipos after insert or update on public.tipos_ocorrencia
  for each row execute function public.auditar_alteracao('TIPO_ALTERADO');
create trigger auditar_config after update on public.configuracoes
  for each row execute function public.auditar_alteracao('CONFIG_ALTERADA');

-- ---------------------------------------------------------------------
-- Regras de acesso (Row Level Security)
-- ---------------------------------------------------------------------

alter table public.configuracoes enable row level security;
alter table public.perfis enable row level security;
alter table public.tipos_ocorrencia enable row level security;
alter table public.ocorrencias enable row level security;
alter table public.historico_status enable row level security;
alter table public.mensagens enable row level security;
alter table public.notificacoes enable row level security;
alter table public.auditoria enable row level security;

create policy "todos leem a configuração" on public.configuracoes
  for select to anon, authenticated using (true);
create policy "direção altera a configuração" on public.configuracoes
  for update to authenticated using (public.e_direcao()) with check (public.e_direcao());

create policy "ver perfis" on public.perfis
  for select to authenticated using (id = auth.uid() or public.acesso_ok());
create policy "direção altera perfis de outras pessoas" on public.perfis
  for update to authenticated
  using (public.e_direcao() and id <> auth.uid())
  with check (public.e_direcao() and id <> auth.uid());

create policy "ver tipos" on public.tipos_ocorrencia
  for select to authenticated using (public.acesso_ok());
create policy "direção cria tipos" on public.tipos_ocorrencia
  for insert to authenticated with check (public.e_direcao());
create policy "direção altera tipos" on public.tipos_ocorrencia
  for update to authenticated using (public.e_direcao()) with check (public.e_direcao());

-- Ocorrências: ninguém altera nem apaga direto. Acompanhamento só pela função atualizar_ocorrencia.
create policy "ver ocorrências" on public.ocorrencias
  for select to authenticated using (public.pode_ver(autor_id));
create policy "registrar ocorrências" on public.ocorrencias
  for insert to authenticated with check (public.acesso_ok() and autor_id = auth.uid());

create policy "ver histórico" on public.historico_status
  for select to authenticated
  using (exists (select 1 from public.ocorrencias o where o.id = ocorrencia_id));

create policy "ver mensagens" on public.mensagens
  for select to authenticated
  using (exists (select 1 from public.ocorrencias o where o.id = ocorrencia_id));
create policy "enviar mensagens" on public.mensagens
  for insert to authenticated
  with check (usuario_id = auth.uid() and exists (select 1 from public.ocorrencias o where o.id = ocorrencia_id));

create policy "ver os próprios avisos" on public.notificacoes
  for select to authenticated using (usuario_id = auth.uid());
create policy "marcar os próprios avisos" on public.notificacoes
  for update to authenticated using (usuario_id = auth.uid()) with check (usuario_id = auth.uid());

create policy "direção vê a auditoria" on public.auditoria
  for select to authenticated using (public.e_direcao());

-- Visão com nomes do tipo e do autor (respeita as regras acima)
create view public.v_ocorrencias with (security_invoker = on) as
  select o.*, t.nome as tipo_nome, t.categoria, p.nome as autor_nome, p.perfil as autor_perfil
  from public.ocorrencias o
  join public.tipos_ocorrencia t on t.id = o.tipo_id
  join public.perfis p on p.id = o.autor_id;

-- ---------------------------------------------------------------------
-- Funções chamadas pelo site
-- ---------------------------------------------------------------------

-- Ações que o próprio site registra na auditoria
create or replace function public.auditar(p_acao text, p_entidade text default null, p_id text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Entre novamente.'; end if;
  if p_acao not in ('LOGIN','LOGOUT','OCORRENCIA_VISUALIZADA','PDF_OCORRENCIA','PDF_RELATORIO',
                    'SENHA_ALTERADA','2FA_ATIVADO','2FA_DESATIVADO') then
    raise exception 'Ação inválida.';
  end if;
  perform public.registrar(p_acao, p_entidade, p_id, null);
end $$;

-- Acompanhamento (Coordenação e Direção)
create or replace function public.atualizar_ocorrencia(p_id bigint, p_status text, p_providencias text, p_observacao text)
returns void language plpgsql security definer set search_path = public as $$
declare oc public.ocorrencias; v_prov text; v_obs text; v_nome text;
begin
  if not public.e_gestor() then raise exception 'Seu perfil não tem acesso a esta função.'; end if;
  select * into oc from public.ocorrencias where id = p_id for update;
  if not found then raise exception 'Ocorrência não encontrada.'; end if;
  if p_status not in ('ABERTA','EM_ACOMPANHAMENTO','ENCERRADA') then raise exception 'Situação inválida.'; end if;
  v_prov := left(coalesce(nullif(trim(p_providencias), ''), oc.providencias), 3000);
  v_obs := left(nullif(trim(coalesce(p_observacao, '')), ''), 1000);
  if p_status = oc.status and v_prov = oc.providencias and v_obs is null then
    raise exception 'Nada foi alterado.';
  end if;
  update public.ocorrencias set status = p_status, providencias = v_prov, atualizado_em = now() where id = p_id;
  insert into public.historico_status (ocorrencia_id, status, observacao, usuario_id)
  values (p_id, p_status,
          coalesce(v_obs, case when v_prov <> oc.providencias then 'Providências atualizadas' end),
          auth.uid());
  select nome into v_nome from public.perfis where id = auth.uid();
  perform public.notificar(p_id, format('Ocorrência nº %s (%s) atualizada por %s: %s', p_id, oc.aluno, v_nome,
    case p_status when 'ABERTA' then 'Aberta' when 'EM_ACOMPANHAMENTO' then 'Em acompanhamento' else 'Encerrada' end),
    auth.uid());
  perform public.registrar('OCORRENCIA_ATUALIZADA', 'ocorrencia', p_id::text,
    jsonb_build_object('status_antes', oc.status, 'status_depois', p_status, 'providencias_alteradas', v_prov <> oc.providencias));
end $$;

-- Indicadores do painel
create or replace function public.painel(p_de date default null, p_ate date default null, p_turma text default null)
returns jsonb language plpgsql stable set search_path = public as $$
declare r jsonb;
begin
  if not public.e_gestor() then raise exception 'Seu perfil não tem acesso a esta função.'; end if;
  with f as (
    select * from public.v_ocorrencias
    where (p_de is null or data_fato >= p_de)
      and (p_ate is null or data_fato <= p_ate)
      and (nullif(trim(p_turma), '') is null or lower(turma) = lower(trim(p_turma)))
  )
  select jsonb_build_object(
    'limite_atencao', (select limite_atencao from public.configuracoes where id = 1),
    'total', (select count(*) from f),
    'por_status', coalesce((select jsonb_agg(x) from (select status as rotulo, count(*) as n from f group by status) x), '[]'),
    'por_categoria', coalesce((select jsonb_agg(x order by x.n desc) from (select categoria as rotulo, count(*) as n from f group by categoria) x), '[]'),
    'por_tipo', coalesce((select jsonb_agg(x order by x.n desc) from (select tipo_nome as rotulo, count(*) as n from f group by tipo_nome order by n desc limit 12) x), '[]'),
    'por_turma', coalesce((select jsonb_agg(x order by x.n desc) from (select turma as rotulo, count(*) as n from f group by turma order by n desc limit 15) x), '[]'),
    'por_mes', coalesce((select jsonb_agg(x order by x.rotulo) from (select to_char(data_fato, 'YYYY-MM') as rotulo, count(*) as n from f group by 1 order by 1 desc limit 12) x), '[]'),
    'alunos', coalesce((select jsonb_agg(x order by x.n desc, x.ultima desc) from (
        select min(aluno) as aluno, turma, count(*) as n,
               count(*) filter (where status <> 'ENCERRADA') as em_aberto,
               count(*) filter (where categoria = 'CONVIVA') as conviva,
               max(data_fato) as ultima
        from f group by lower(aluno), turma order by n desc, ultima desc limit 20) x), '[]')
  ) into r;
  return r;
end $$;

-- Sugestões de turmas e estudantes para os campos de preenchimento
create or replace function public.sugestoes() returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object(
    'turmas', coalesce((select jsonb_agg(t order by t) from (select distinct turma as t from public.ocorrencias) s), '[]'),
    'alunos', coalesce((select jsonb_agg(a order by a) from (select distinct aluno as a from public.ocorrencias limit 3000) s), '[]'))
$$;

-- Usuários (Direção)
create or replace function public.listar_usuarios()
returns table (id uuid, nome text, email text, perfil text, ativo boolean, trocar_senha boolean, duplo_fator boolean, criado_em timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.e_direcao() then raise exception 'Seu perfil não tem acesso a esta função.'; end if;
  return query
    select p.id, p.nome, p.email, p.perfil, p.ativo, p.trocar_senha,
           exists (select 1 from auth.mfa_factors f where f.user_id = p.id and f.status = 'verified'),
           p.criado_em
    from public.perfis p
    order by (p.perfil is null) desc, p.ativo desc, p.nome;
end $$;

create or replace function public.definir_perfil(p_usuario uuid, p_perfil text, p_trocar_senha boolean default false)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.e_direcao() then raise exception 'Seu perfil não tem acesso a esta função.'; end if;
  if p_usuario = auth.uid() then raise exception 'Peça a outra pessoa da Direção para alterar o seu perfil.'; end if;
  if p_perfil not in ('AOE','PROFESSOR','COORDENACAO','DIRECAO') then raise exception 'Perfil inválido.'; end if;
  update public.perfis set perfil = p_perfil, trocar_senha = trocar_senha or p_trocar_senha where id = p_usuario;
  if not found then raise exception 'Usuário não encontrado.'; end if;
  update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = p_usuario;
end $$;

create or replace function public.redefinir_senha(p_usuario uuid) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare v_senha text;
begin
  if not public.e_direcao() then raise exception 'Seu perfil não tem acesso a esta função.'; end if;
  v_senha := translate(encode(extensions.gen_random_bytes(9), 'base64'), '+/=', 'kmz') || '7';
  update auth.users set encrypted_password = extensions.crypt(v_senha, extensions.gen_salt('bf')), updated_at = now()
  where id = p_usuario;
  if not found then raise exception 'Usuário não encontrado.'; end if;
  update public.perfis set trocar_senha = true where id = p_usuario;
  perform public.registrar('USUARIO_SENHA_RESETADA', 'usuario', p_usuario::text, null);
  return v_senha;
end $$;

create or replace function public.resetar_2fa(p_usuario uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.e_direcao() then raise exception 'Seu perfil não tem acesso a esta função.'; end if;
  delete from auth.mfa_factors where user_id = p_usuario;
  perform public.registrar('USUARIO_2FA_RESETADO', 'usuario', p_usuario::text, null);
end $$;

-- A própria pessoa avisa que trocou a senha provisória
create or replace function public.senha_trocada() returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.perfis set trocar_senha = false where id = auth.uid();
  perform public.registrar('SENHA_DEFINIDA', 'usuario', auth.uid()::text, null);
end $$;

revoke execute on function public.listar_usuarios() from anon;
revoke execute on function public.definir_perfil(uuid, text, boolean) from anon;
revoke execute on function public.redefinir_senha(uuid) from anon;
revoke execute on function public.resetar_2fa(uuid) from anon;

-- ---------------------------------------------------------------------
-- Tempo real (avisos, chat e atualizações)
-- ---------------------------------------------------------------------
alter publication supabase_realtime add table public.notificacoes, public.mensagens, public.ocorrencias;
