-- =====================================================================
-- SisRoe - Migração: funções de acesso configuráveis + chat fechado em
-- ocorrências encerradas (inclui também a troca para código no e-mail).
-- Rode UMA VEZ no SQL Editor, em um banco que já tem o SisRoe instalado.
-- Ocorrências, conversas, usuários e auditoria são mantidos.
-- =====================================================================

-- 1. Restos da versão com senha e autenticador (se ainda existirem)
drop function if exists public.redefinir_senha(uuid);
drop function if exists public.resetar_2fa(uuid);
drop function if exists public.senha_trocada();
drop function if exists public.definir_perfil(uuid, text, boolean);
drop function if exists public.definir_perfil(uuid, text);
drop function if exists public.listar_usuarios();
alter table public.configuracoes drop column if exists exigir_2fa;
alter table public.perfis drop column if exists trocar_senha;
delete from auth.mfa_factors;

-- 2. Tabela de funções
-- Funções de acesso (categorias de usuários). A Direção cria e configura.
create table if not exists public.funcoes (
  id bigint generated always as identity primary key,
  nome text not null unique check (length(trim(nome)) between 2 and 60),
  descricao text not null default '' check (length(descricao) <= 300),
  direcao boolean not null default false,       -- função fixa da Direção: acesso total
  registrar boolean not null default true,      -- registrar ocorrências
  ver_todas boolean not null default false,     -- ver ocorrências de todos (senão, só as próprias)
  conversar boolean not null default true,      -- participar do chat das ocorrências
  acompanhar boolean not null default false,    -- atualizar situação e providências
  painel boolean not null default false,        -- painel de indicadores
  relatorios boolean not null default false,    -- PDFs e relatórios
  configuracoes boolean not null default false, -- dados da escola e tipos de ocorrência
  auditoria boolean not null default false,     -- consultar a auditoria
  categorias text[] not null default array['ADMINISTRATIVA','PEDAGOGICA','CONVIVA']
    check (cardinality(categorias) > 0 and categorias <@ array['ADMINISTRATIVA','PEDAGOGICA','CONVIVA']),
  criado_em timestamptz not null default now()
);
create unique index if not exists funcoes_uma_direcao on public.funcoes (direcao) where direcao;

insert into public.funcoes (nome, descricao, direcao, registrar, ver_todas, conversar, acompanhar, painel, relatorios, configuracoes, auditoria) values
  ('Direção', 'Acesso total. Única função que cadastra pessoas e cria funções.', true, true, true, true, true, true, true, true, true),
  ('Coordenação', 'Acompanha todas as ocorrências.', false, true, true, true, true, true, true, false, false),
  ('Agente de Organização Escolar', 'Registra e acompanha as próprias ocorrências.', false, true, false, true, false, false, false, false, false),
  ('Professor(a)', 'Registra e acompanha as próprias ocorrências.', false, true, false, true, false, false, false, false, false)
on conflict (nome) do nothing;

-- 3. Cada pessoa recebe a função equivalente ao perfil que já tinha
alter table public.perfis add column if not exists funcao_id bigint references public.funcoes(id) on delete restrict;

do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'perfis' and column_name = 'perfil') then
    update public.perfis p set funcao_id = f.id
    from public.funcoes f
    where p.funcao_id is null
      and f.nome = case p.perfil
                     when 'DIRECAO' then 'Direção'
                     when 'COORDENACAO' then 'Coordenação'
                     when 'AOE' then 'Agente de Organização Escolar'
                     when 'PROFESSOR' then 'Professor(a)'
                   end;
  end if;
end $$;

-- 4. Remove o que dependia dos perfis fixos
drop view if exists public.v_ocorrencias;
drop policy if exists "direção altera a configuração" on public.configuracoes;
drop policy if exists "direção cria tipos" on public.tipos_ocorrencia;
drop policy if exists "direção altera tipos" on public.tipos_ocorrencia;
drop policy if exists "direção vê a auditoria" on public.auditoria;

-- =====================================================================
-- LÓGICA: permissões, gatilhos, regras de acesso e funções do site.
-- (Esta parte pode ser rodada de novo sem perder dados.)
-- =====================================================================

alter table public.funcoes enable row level security;

-- ---------------------------------------------------------------------
-- Permissões
-- ---------------------------------------------------------------------

-- A pessoa logada pode fazer isto? ('acesso' = tem função e está ativa)
create or replace function public.pode(p_perm text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare fu public.funcoes;
begin
  select f.* into fu
  from public.perfis pe join public.funcoes f on f.id = pe.funcao_id
  where pe.id = auth.uid() and pe.ativo;
  if not found then return false; end if;
  if fu.direcao then return true; end if;
  return case p_perm
    when 'acesso' then true
    when 'registrar' then fu.registrar
    when 'ver_todas' then fu.ver_todas
    when 'conversar' then fu.conversar
    when 'acompanhar' then fu.acompanhar
    when 'painel' then fu.painel
    when 'relatorios' then fu.relatorios
    when 'configuracoes' then fu.configuracoes
    when 'auditoria' then fu.auditoria
    else false
  end;
end $$;

create or replace function public.acesso_ok() returns boolean
language sql stable security definer set search_path = public as $$
  select public.pode('acesso')
$$;

create or replace function public.e_direcao() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select f.direcao from public.perfis pe join public.funcoes f on f.id = pe.funcao_id
    where pe.id = auth.uid() and pe.ativo), false)
$$;

-- A pessoa logada enxerga esta categoria (Administrativa, Pedagógica, Conviva)?
create or replace function public.ve_categoria(p_categoria text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select f.direcao or p_categoria = any (f.categorias)
    from public.perfis pe join public.funcoes f on f.id = pe.funcao_id
    where pe.id = auth.uid() and pe.ativo), false)
$$;

-- Pode ver esta ocorrência? Categoria liberada E (vê todas OU foi quem registrou)
create or replace function public.pode_ver(p_autor uuid, p_tipo bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select public.pode('acesso')
     and public.ve_categoria((select categoria from public.tipos_ocorrencia where id = p_tipo))
     and (public.pode('ver_todas') or p_autor = auth.uid())
$$;

create or replace function public.ip_atual() returns text
language sql stable as $$
  select split_part(coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-forwarded-for', ''), ',', 1)
$$;

create or replace function public.registrar(p_acao text, p_entidade text, p_id text, p_detalhes jsonb)
returns void language sql security definer set search_path = public as $$
  insert into public.auditoria (usuario_id, acao, entidade, entidade_id, detalhes, ip)
  values (auth.uid(), p_acao, p_entidade, p_id, p_detalhes, public.ip_atual());
$$;

-- Avisa quem enxerga a ocorrência (vê todas e tem a categoria liberada) e o autor
create or replace function public.notificar(p_oc bigint, p_texto text, p_exceto uuid)
returns void language sql security definer set search_path = public as $$
  with oc as (
    select o.autor_id, t.categoria
    from public.ocorrencias o join public.tipos_ocorrencia t on t.id = o.tipo_id
    where o.id = p_oc
  )
  insert into public.notificacoes (usuario_id, ocorrencia_id, texto)
  select pe.id, p_oc, p_texto
  from public.perfis pe
  join public.funcoes f on f.id = pe.funcao_id
  cross join oc
  where pe.ativo
    and pe.id is distinct from p_exceto
    and (pe.id = oc.autor_id or f.direcao or (f.ver_todas and oc.categoria = any (f.categorias)));
$$;

revoke execute on function public.registrar(text, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.notificar(bigint, text, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Gatilhos
-- ---------------------------------------------------------------------

create or replace function public.novo_usuario() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.perfis (id, nome, email)
  values (new.id,
          coalesce(nullif(trim(new.raw_user_meta_data ->> 'nome'), ''), split_part(new.email, '@', 1)),
          new.email);
  return new;
end $$;
drop trigger if exists ao_criar_usuario on auth.users;
create trigger ao_criar_usuario after insert on auth.users
  for each row execute function public.novo_usuario();

-- A função Direção é fixa; nenhuma outra pode virar Direção
create or replace function public.proteger_funcao() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.direcao := false;
    return new;
  end if;
  if old.direcao then
    raise exception 'A função Direção é fixa e não pode ser alterada nem excluída.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  new.direcao := false;
  return new;
end $$;
drop trigger if exists proteger_funcao on public.funcoes;
create trigger proteger_funcao before insert or update or delete on public.funcoes
  for each row execute function public.proteger_funcao();

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
drop trigger if exists validar_ocorrencia on public.ocorrencias;
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
drop trigger if exists apos_ocorrencia on public.ocorrencias;
create trigger apos_ocorrencia after insert on public.ocorrencias
  for each row execute function public.apos_ocorrencia();

-- Chat: fecha quando a ocorrência é encerrada
create or replace function public.validar_mensagem() returns trigger
language plpgsql set search_path = public as $$
begin
  new.usuario_id := auth.uid();
  new.texto := trim(new.texto);
  new.criado_em := now();
  if (select status from public.ocorrencias where id = new.ocorrencia_id) = 'ENCERRADA' then
    raise exception 'Esta ocorrência está encerrada e a conversa foi fechada. Para conversar de novo, reabra a ocorrência.';
  end if;
  return new;
end $$;
drop trigger if exists validar_mensagem on public.mensagens;
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
drop trigger if exists apos_mensagem on public.mensagens;
create trigger apos_mensagem after insert on public.mensagens
  for each row execute function public.apos_mensagem();

create or replace function public.auditar_perfis() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.funcao_id is distinct from old.funcao_id then
    perform public.registrar('USUARIO_FUNCAO', 'usuario', new.id::text,
      jsonb_build_object('de', (select nome from public.funcoes where id = old.funcao_id),
                         'para', (select nome from public.funcoes where id = new.funcao_id)));
  end if;
  if new.ativo is distinct from old.ativo then
    perform public.registrar(case when new.ativo then 'USUARIO_ATIVADO' else 'USUARIO_DESATIVADO' end,
      'usuario', new.id::text, null);
  end if;
  return new;
end $$;
drop trigger if exists auditar_perfis on public.perfis;
create trigger auditar_perfis after update on public.perfis
  for each row execute function public.auditar_perfis();

create or replace function public.auditar_alteracao() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    perform public.registrar(tg_argv[0], tg_table_name, old.id::text, to_jsonb(old));
    return old;
  end if;
  perform public.registrar(tg_argv[0], tg_table_name, new.id::text, to_jsonb(new));
  return new;
end $$;
drop trigger if exists auditar_tipos on public.tipos_ocorrencia;
create trigger auditar_tipos after insert or update on public.tipos_ocorrencia
  for each row execute function public.auditar_alteracao('TIPO_ALTERADO');
drop trigger if exists auditar_config on public.configuracoes;
create trigger auditar_config after update on public.configuracoes
  for each row execute function public.auditar_alteracao('CONFIG_ALTERADA');
drop trigger if exists auditar_funcoes on public.funcoes;
create trigger auditar_funcoes after insert or update or delete on public.funcoes
  for each row execute function public.auditar_alteracao('FUNCAO_ALTERADA');

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

drop policy if exists "todos leem a configuração" on public.configuracoes;
create policy "todos leem a configuração" on public.configuracoes
  for select to anon, authenticated using (true);
drop policy if exists "alterar a configuração" on public.configuracoes;
create policy "alterar a configuração" on public.configuracoes
  for update to authenticated using (public.pode('configuracoes')) with check (public.pode('configuracoes'));

drop policy if exists "ver funções" on public.funcoes;
create policy "ver funções" on public.funcoes
  for select to authenticated using (true);
drop policy if exists "direção cria funções" on public.funcoes;
create policy "direção cria funções" on public.funcoes
  for insert to authenticated with check (public.e_direcao());
drop policy if exists "direção altera funções" on public.funcoes;
create policy "direção altera funções" on public.funcoes
  for update to authenticated using (public.e_direcao()) with check (public.e_direcao());
drop policy if exists "direção exclui funções" on public.funcoes;
create policy "direção exclui funções" on public.funcoes
  for delete to authenticated using (public.e_direcao());

drop policy if exists "ver perfis" on public.perfis;
create policy "ver perfis" on public.perfis
  for select to authenticated using (id = auth.uid() or public.acesso_ok());
drop policy if exists "direção altera perfis de outras pessoas" on public.perfis;
create policy "direção altera perfis de outras pessoas" on public.perfis
  for update to authenticated
  using (public.e_direcao() and id <> auth.uid())
  with check (public.e_direcao() and id <> auth.uid());

drop policy if exists "ver tipos" on public.tipos_ocorrencia;
create policy "ver tipos" on public.tipos_ocorrencia
  for select to authenticated using (public.acesso_ok());
drop policy if exists "criar tipos" on public.tipos_ocorrencia;
create policy "criar tipos" on public.tipos_ocorrencia
  for insert to authenticated with check (public.pode('configuracoes'));
drop policy if exists "alterar tipos" on public.tipos_ocorrencia;
create policy "alterar tipos" on public.tipos_ocorrencia
  for update to authenticated using (public.pode('configuracoes')) with check (public.pode('configuracoes'));

drop policy if exists "ver ocorrências" on public.ocorrencias;
create policy "ver ocorrências" on public.ocorrencias
  for select to authenticated using (public.pode_ver(autor_id, tipo_id));
drop policy if exists "registrar ocorrências" on public.ocorrencias;
create policy "registrar ocorrências" on public.ocorrencias
  for insert to authenticated
  with check (public.pode('registrar') and autor_id = auth.uid()
              and public.ve_categoria((select categoria from public.tipos_ocorrencia where id = tipo_id)));

drop policy if exists "ver histórico" on public.historico_status;
create policy "ver histórico" on public.historico_status
  for select to authenticated
  using (exists (select 1 from public.ocorrencias o where o.id = ocorrencia_id));

drop policy if exists "ver mensagens" on public.mensagens;
create policy "ver mensagens" on public.mensagens
  for select to authenticated
  using (public.pode('conversar') and exists (select 1 from public.ocorrencias o where o.id = ocorrencia_id));
drop policy if exists "enviar mensagens" on public.mensagens;
create policy "enviar mensagens" on public.mensagens
  for insert to authenticated
  with check (public.pode('conversar') and usuario_id = auth.uid()
              and exists (select 1 from public.ocorrencias o where o.id = ocorrencia_id and o.status <> 'ENCERRADA'));

drop policy if exists "ver os próprios avisos" on public.notificacoes;
create policy "ver os próprios avisos" on public.notificacoes
  for select to authenticated using (usuario_id = auth.uid());
drop policy if exists "marcar os próprios avisos" on public.notificacoes;
create policy "marcar os próprios avisos" on public.notificacoes
  for update to authenticated using (usuario_id = auth.uid()) with check (usuario_id = auth.uid());

drop policy if exists "ver a auditoria" on public.auditoria;
create policy "ver a auditoria" on public.auditoria
  for select to authenticated using (public.pode('auditoria'));

-- Visão com nomes do tipo, do autor e da função dele (respeita as regras acima)
drop view if exists public.v_ocorrencias;
create view public.v_ocorrencias with (security_invoker = on) as
  select o.*, t.nome as tipo_nome, t.categoria, p.nome as autor_nome, f.nome as autor_funcao
  from public.ocorrencias o
  join public.tipos_ocorrencia t on t.id = o.tipo_id
  join public.perfis p on p.id = o.autor_id
  left join public.funcoes f on f.id = p.funcao_id;

-- ---------------------------------------------------------------------
-- Funções chamadas pelo site
-- ---------------------------------------------------------------------

create or replace function public.auditar(p_acao text, p_entidade text default null, p_id text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Entre novamente.'; end if;
  if p_acao not in ('LOGIN','LOGOUT','OCORRENCIA_VISUALIZADA','PDF_OCORRENCIA','PDF_RELATORIO','SAIR_DE_TODOS') then
    raise exception 'Ação inválida.';
  end if;
  perform public.registrar(p_acao, p_entidade, p_id, null);
end $$;

create or replace function public.atualizar_ocorrencia(p_id bigint, p_status text, p_providencias text, p_observacao text)
returns void language plpgsql security definer set search_path = public as $$
declare oc public.ocorrencias; v_prov text; v_obs text; v_nome text;
begin
  if not public.pode('acompanhar') then raise exception 'Sua função não tem acesso a esta ação.'; end if;
  select * into oc from public.ocorrencias where id = p_id for update;
  if not found or not public.pode_ver(oc.autor_id, oc.tipo_id) then raise exception 'Ocorrência não encontrada.'; end if;
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

-- Painel: os números consideram só o que a pessoa pode ver
create or replace function public.painel(p_de date default null, p_ate date default null, p_turma text default null)
returns jsonb language plpgsql stable set search_path = public as $$
declare r jsonb;
begin
  if not public.pode('painel') then raise exception 'Sua função não tem acesso a esta ação.'; end if;
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

create or replace function public.sugestoes() returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object(
    'turmas', coalesce((select jsonb_agg(t order by t) from (select distinct turma as t from public.ocorrencias) s), '[]'),
    'alunos', coalesce((select jsonb_agg(a order by a) from (select distinct aluno as a from public.ocorrencias limit 3000) s), '[]'))
$$;

-- Usuários (somente Direção)
create or replace function public.listar_usuarios()
returns table (id uuid, nome text, email text, funcao_id bigint, funcao_nome text, ativo boolean, criado_em timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.e_direcao() then raise exception 'Somente a Direção gerencia usuários.'; end if;
  return query
    select p.id, p.nome, p.email, p.funcao_id, f.nome, p.ativo, p.criado_em
    from public.perfis p left join public.funcoes f on f.id = p.funcao_id
    order by (p.funcao_id is null) desc, p.ativo desc, p.nome;
end $$;

create or replace function public.definir_funcao(p_usuario uuid, p_funcao bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.e_direcao() then raise exception 'Somente a Direção gerencia usuários.'; end if;
  if p_usuario = auth.uid() then raise exception 'Peça a outra pessoa da Direção para alterar a sua função.'; end if;
  if not exists (select 1 from public.funcoes where id = p_funcao) then raise exception 'Função inválida.'; end if;
  update public.perfis set funcao_id = p_funcao where id = p_usuario;
  if not found then raise exception 'Usuário não encontrado.'; end if;
  update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = p_usuario;
end $$;

revoke execute on function public.listar_usuarios() from anon;
revoke execute on function public.definir_funcao(uuid, bigint) from anon;


-- 5. Limpeza final
drop function if exists public.pode_ver(uuid);
drop function if exists public.e_gestor();
drop function if exists public.meu_perfil();
alter table public.perfis drop column if exists perfil;

-- Conferência: todos devem aparecer com a função certa
select p.nome, p.email, f.nome as funcao from public.perfis p left join public.funcoes f on f.id = p.funcao_id order by f.nome, p.nome;
