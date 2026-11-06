(function () {
  'use strict';

  /* ================= Utilitários ================= */
  const $ = (sel, raiz) => (raiz || document).querySelector(sel);
  const $$ = (sel, raiz) => Array.from((raiz || document).querySelectorAll(sel));
  const conteudo = $('#conteudo');

  const STATUS = { ABERTA: 'Aberta', EM_ACOMPANHAMENTO: 'Em acompanhamento', ENCERRADA: 'Encerrada' };
  const CATEGORIA = { ADMINISTRATIVA: 'Administrativa', PEDAGOGICA: 'Pedagógica', CONVIVA: 'Conviva (média gravidade)' };
  const PERMISSOES = [
    ['registrar', 'Registrar ocorrências', ''],
    ['ver_todas', 'Ver as ocorrências de todos', 'Sem isto, vê só as que registrou.'],
    ['conversar', 'Participar da conversa das ocorrências', 'Ler e escrever no chat de cada ocorrência.'],
    ['acompanhar', 'Atualizar situação e providências', 'Inclui encerrar e reabrir ocorrências.'],
    ['painel', 'Ver o painel de indicadores', 'Os números consideram só o que a função pode ver.'],
    ['relatorios', 'Gerar PDFs e relatórios', ''],
    ['configuracoes', 'Editar dados da escola e tipos de ocorrência', ''],
    ['auditoria', 'Consultar a auditoria', 'Mostra acessos e ações de todas as pessoas.'],
  ];
  const POR_PAGINA = 30;

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  const dataBR = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '');
  const dataHora = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '');
  function hoje() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  const carimbo = (s, grande) => `<span class="carimbo ${s}${grande ? ' grande' : ''}">${esc(STATUS[s])}</span>`;
  const opcoes = (mapa, sel, vazio) =>
    (vazio ? `<option value="">${esc(vazio)}</option>` : '') +
    Object.entries(mapa).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(v)}</option>`).join('');
  const qs = (obj) => new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== '' && v != null)).toString();
  const lerForm = (form) => Object.fromEntries(new FormData(form).entries());
  const limparBusca = (s) => String(s || '').replace(/[,()%*\\]/g, ' ').trim();
  const exato = (s) => String(s || '').trim().replace(/[\\%_]/g, (c) => '\\' + c);

  // Traduz erros do Supabase para mensagens claras
  function erroPT(e) {
    const m = (e && (e.message || e.error_description)) || String(e);
    const mapa = [
      [/expired|invalid.*token|token.*invalid|otp_expired/i, 'Código inválido ou vencido. Peça um novo código.'],
      [/only request this after|security purposes/i, 'Aguarde alguns segundos antes de pedir outro código.'],
      [/email rate limit|over_email_send_rate_limit/i, 'Limite de envio de e-mails atingido. Tente em alguns minutos ou avise a Direção.'],
      [/not authorized|email_address_not_authorized/i, 'O envio de e-mails ainda não foi configurado no Supabase (SMTP). Avise a Direção.'],
      [/already registered|already been registered/i, 'Esse e-mail já está cadastrado.'],
      [/row-level security/i, 'Sua função não tem acesso a esta ação.'],
      [/rate limit|too many/i, 'Muitas tentativas. Aguarde alguns minutos.'],
      [/Failed to fetch|NetworkError/i, 'Sem conexão com o servidor. Verifique a internet.'],
    ];
    for (const [re, txt] of mapa) if (re.test(m)) return txt;
    return m;
  }
  function ok(resp) {
    if (resp.error) throw new Error(erroPT(resp.error));
    return resp.data;
  }

  let toastTimer;
  function toast(texto, aoClicar) {
    const t = $('#toast');
    t.textContent = texto;
    t.classList.remove('oculto');
    t.onclick = () => { t.classList.add('oculto'); if (aoClicar) aoClicar(); };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('oculto'), 6000);
  }

  // Senha longa e aleatória, descartada: ninguém entra por senha, só por código no e-mail
  function senhaDescartavel() {
    const v = crypto.getRandomValues(new Uint8Array(32));
    return Array.from(v, (n) => n.toString(16).padStart(2, '0')).join('') + 'Aa1';
  }

  /* ================= Supabase ================= */
  const CFG = window.SISROE_CONFIG || {};
  const configurado = CFG.supabaseUrl && !/SEU-PROJETO/.test(CFG.supabaseUrl) && CFG.supabaseAnonKey && !/COLE-AQUI/.test(CFG.supabaseAnonKey);
  const sb = configurado ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey) : null;

  let escola = { escola_nome: 'Unidade Escolar', escola_endereco: '', limite_atencao: 3 };
  let eu = null;
  let tipos = [];
  let ocAtual = null;
  let canalOc = null;
  let veioDoLogin = false;

  // Permissões da função de quem está logado (a Direção pode tudo). O banco confere de novo.
  const ehDirecao = () => !!(eu && eu.funcao && eu.funcao.direcao);
  const pode = (perm) => ehDirecao() || !!(eu && eu.funcao && eu.funcao[perm]);
  const categoriasVisiveis = () =>
    Object.keys(CATEGORIA).filter((c) => ehDirecao() || (eu.funcao.categorias || []).includes(c));
  const CATEGORIA_VISIVEL = () => Object.fromEntries(categoriasVisiveis().map((c) => [c, CATEGORIA[c]]));
  const auditar = (acao, entidade, id) =>
    sb.rpc('auditar', { p_acao: acao, p_entidade: entidade || null, p_id: id != null ? String(id) : null }).then(() => {});

  async function carregarEscola() {
    const r = await sb.from('configuracoes').select('*').eq('id', 1).maybeSingle();
    if (r.data) escola = r.data;
    $('#escola-login').textContent = escola.escola_nome;
    $('#escola-app').textContent = escola.escola_nome;
    document.title = 'SisRoe | ' + escola.escola_nome;
  }

  /* ================= Entrada por código no e-mail ================= */
  const ETAPAS = ['carregando', 'sem-config', 'f-login', 'f-codigo', 'aguardando'];
  function mostrarEtapa(id) {
    $('#tela-app').classList.add('oculto');
    $('#tela-login').classList.remove('oculto');
    ETAPAS.forEach((e) => $('#' + e).classList.toggle('oculto', e !== id));
    $('#erro').textContent = '';
    const campo = $('#' + id + ' input');
    if (campo) campo.focus();
  }

  async function fluxo() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return mostrarEtapa('f-login');
    const meu = ok(await sb.from('perfis').select('*, funcao:funcoes(*)').eq('id', session.user.id).maybeSingle());
    if (!meu || !meu.funcao || !meu.ativo) return mostrarEtapa('aguardando');
    eu = meu;
    if (veioDoLogin) { auditar('LOGIN', 'usuario', eu.id); veioDoLogin = false; }
    iniciarApp();
  }

  let emailLogin = '';
  async function enviarCodigo() {
    const r = await sb.auth.signInWithOtp({ email: emailLogin, options: { shouldCreateUser: false } });
    // E-mail não cadastrado: não revelamos isso, para ninguém descobrir quem tem acesso
    if (r.error && !/signups? not allowed|not found|user not found/i.test(r.error.message)) {
      throw new Error(erroPT(r.error));
    }
  }

  let esperaTimer;
  function bloquearReenvio(segundos) {
    const b = $('#reenviar');
    clearInterval(esperaTimer);
    let s = segundos;
    b.disabled = true;
    b.textContent = `Enviar outro código (${s}s)`;
    esperaTimer = setInterval(() => {
      s -= 1;
      if (s <= 0) { clearInterval(esperaTimer); b.disabled = false; b.textContent = 'Enviar outro código'; }
      else b.textContent = `Enviar outro código (${s}s)`;
    }, 1000);
  }

  function aoEnviar(formId, acao) {
    $('#' + formId).addEventListener('submit', async (e) => {
      e.preventDefault();
      const botao = $('button[type=submit]', e.target);
      botao.disabled = true;
      $('#erro').textContent = '';
      try {
        await acao();
      } catch (err) {
        $('#erro').textContent = erroPT(err);
      } finally {
        botao.disabled = false;
      }
    });
  }

  aoEnviar('f-login', async () => {
    emailLogin = $('#email').value.trim().toLowerCase();
    await enviarCodigo();
    $('#email-enviado').textContent = emailLogin;
    mostrarEtapa('f-codigo');
    bloquearReenvio(60);
  });
  aoEnviar('f-codigo', async () => {
    const token = $('#codigo').value.replace(/\s/g, '');
    ok(await sb.auth.verifyOtp({ email: emailLogin, token, type: 'email' }));
    $('#codigo').value = '';
    veioDoLogin = true;
    await fluxo();
  });
  $('#reenviar').addEventListener('click', async () => {
    $('#erro').textContent = '';
    try { await enviarCodigo(); bloquearReenvio(60); toast('Novo código enviado.'); }
    catch (err) { $('#erro').textContent = erroPT(err); }
  });
  $('#trocar-email').addEventListener('click', () => mostrarEtapa('f-login'));

  async function sair() {
    try { await auditar('LOGOUT', 'usuario', eu && eu.id); } catch (e) { /* segue */ }
    await sb.auth.signOut();
    location.hash = '';
    location.reload();
  }
  $('#sair').addEventListener('click', sair);
  $('#sair-aguardando').addEventListener('click', sair);

  /* ================= Aplicação ================= */
  function iniciarApp() {
    $('#tela-login').classList.add('oculto');
    $('#tela-app').classList.remove('oculto');
    montarMenu();
    carregarNotificacoes();
    conectarAvisos();
    window.addEventListener('hashchange', rotear);
    if (!location.hash) location.hash = pode('painel') ? '#/painel' : '#/ocorrencias';
    else rotear();
  }

  function montarMenu() {
    const itens = [
      ['#/ocorrencias', pode('ver_todas') ? 'Ocorrências' : 'Minhas ocorrências', true],
      ['#/nova', 'Registrar ocorrência', pode('registrar')],
      ['#/painel', 'Painel', pode('painel')],
      ['#/relatorios', 'Relatórios', pode('relatorios')],
      ['#/usuarios', 'Usuários', ehDirecao()],
      ['#/funcoes', 'Funções de acesso', ehDirecao()],
      ['#/configuracoes', 'Configurações', pode('configuracoes')],
      ['#/auditoria', 'Auditoria', pode('auditoria')],
      ['#/conta', 'Minha conta', true],
    ];
    $('#menu').innerHTML = itens.filter((i) => i[2]).map(([h, t]) => `<a href="${h}">${esc(t)}</a>`).join('');
    $('#nome-usuario').textContent = eu.nome;
    $('#perfil-usuario').textContent = eu.funcao.nome;
  }
  function marcarMenu() {
    const base = location.hash.split('?')[0];
    $$('#menu a').forEach((a) => a.classList.toggle('ativo', a.getAttribute('href') === base));
    $('#lateral').classList.remove('aberta');
  }
  $('#abrir-menu').addEventListener('click', () => $('#lateral').classList.toggle('aberta'));

  /* ================= Avisos em tempo real ================= */
  async function carregarNotificacoes() {
    const itens = ok(await sb.from('notificacoes').select('*').order('id', { ascending: false }).limit(30));
    const naoLidas = itens.filter((i) => !i.lida).length;
    const c = $('#contador');
    c.textContent = naoLidas > 29 ? '30+' : naoLidas;
    c.classList.toggle('oculto', !naoLidas);
    $('#lista-notif').innerHTML = itens.length
      ? itens.map((i) => `<a href="#/ocorrencia/${i.ocorrencia_id}" class="${i.lida ? '' : 'nao-lida'}">${esc(i.texto)}<br><span class="muted">${dataHora(i.criado_em)}</span></a>`).join('')
      : '<p class="vazio">Nenhum aviso por enquanto.</p>';
  }
  $('#botao-sino').addEventListener('click', async (e) => {
    e.stopPropagation();
    const lista = $('#lista-notif');
    const abrir = lista.classList.contains('oculto');
    lista.classList.toggle('oculto', !abrir);
    $('#botao-sino').setAttribute('aria-expanded', abrir);
    if (abrir) {
      await carregarNotificacoes();
      await sb.from('notificacoes').update({ lida: true }).eq('usuario_id', eu.id).eq('lida', false);
      $('#contador').classList.add('oculto');
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.sino')) $('#lista-notif').classList.add('oculto');
  });

  function conectarAvisos() {
    sb.channel('avisos-' + eu.id)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notificacoes', filter: `usuario_id=eq.${eu.id}` }, (p) => {
        const n = p.new;
        const c = $('#contador');
        c.textContent = (parseInt(c.textContent, 10) || 0) + 1;
        c.classList.remove('oculto');
        if (!(ocAtual === n.ocorrencia_id && /comentou/.test(n.texto))) {
          toast(n.texto, () => { location.hash = '#/ocorrencia/' + n.ocorrencia_id; });
        }
      })
      .subscribe();
  }

  /* ================= Roteador ================= */
  async function rotear() {
    const [caminho, consulta] = location.hash.replace(/^#/, '').split('?');
    const params = Object.fromEntries(new URLSearchParams(consulta || ''));
    const partes = caminho.split('/').filter(Boolean);

    if (ocAtual && !(partes[0] === 'ocorrencia' && Number(partes[1]) === ocAtual)) {
      if (canalOc) sb.removeChannel(canalOc);
      canalOc = null;
      ocAtual = null;
    }
    marcarMenu();
    conteudo.innerHTML = '<p class="muted">Carregando…</p>';
    try {
      switch (partes[0]) {
        case 'nova': return await telaNova();
        case 'ocorrencia': return await telaDetalhe(Number(partes[1]));
        case 'painel': return await telaPainel(params);
        case 'relatorios': return await telaRelatorios();
        case 'usuarios': return await telaUsuarios();
        case 'funcoes': return await telaFuncoes();
        case 'configuracoes': return await telaConfiguracoes();
        case 'auditoria': return await telaAuditoria(params);
        case 'conta': return await telaConta();
        default: return await telaLista(params);
      }
    } catch (err) {
      conteudo.innerHTML = `<p class="erro">${esc(erroPT(err))}</p>`;
    } finally {
      conteudo.focus({ preventScroll: true });
    }
  }

  async function sugestoes() {
    const s = ok(await sb.rpc('sugestoes'));
    return `<datalist id="dl-turmas">${(s.turmas || []).map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
            <datalist id="dl-alunos">${(s.alunos || []).map((a) => `<option value="${esc(a)}">`).join('')}</datalist>`;
  }

  // Aplica os filtros da tela na consulta de v_ocorrencias
  function filtrar(q, p) {
    const busca = limparBusca(p.q);
    if (busca) q = q.or(`aluno.ilike.*${busca}*,descricao.ilike.*${busca}*,turma.ilike.*${busca}*`);
    if (p.aluno) q = q.ilike('aluno', exato(p.aluno));
    if (p.turma) q = q.ilike('turma', exato(p.turma));
    if (STATUS[p.status]) q = q.eq('status', p.status);
    if (CATEGORIA[p.categoria]) q = q.eq('categoria', p.categoria);
    if (/^\d{4}-\d{2}-\d{2}$/.test(p.de || '')) q = q.gte('data_fato', p.de);
    if (/^\d{4}-\d{2}-\d{2}$/.test(p.ate || '')) q = q.lte('data_fato', p.ate);
    return q;
  }

  /* ================= Lista de ocorrências ================= */
  async function telaLista(p) {
    const pagina = Math.max(1, Number(p.pagina) || 1);
    let q = sb.from('v_ocorrencias').select('*', { count: 'exact' });
    q = filtrar(q, p).order('data_fato', { ascending: false }).order('id', { ascending: false })
      .range((pagina - 1) * POR_PAGINA, pagina * POR_PAGINA - 1);
    const r = await q;
    if (r.error) throw r.error;
    const total = r.count || 0;
    const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
    const titulo = p.aluno ? `Histórico de ${p.aluno}` : pode('ver_todas') ? 'Ocorrências' : 'Minhas ocorrências';

    conteudo.innerHTML = `
      <div class="cabecalho-pagina">
        <div><h1>${esc(titulo)}</h1><p class="muted">${total} registro(s)</p></div>
        ${pode('registrar') ? '<a class="btn" href="#/nova">Registrar ocorrência</a>' : ''}
      </div>
      ${await sugestoes()}
      <form class="filtros" id="f-filtros">
        <div><label for="fq">Buscar estudante, turma ou texto</label><input id="fq" name="q" value="${esc(p.q || '')}" placeholder="Digite o nome do estudante"></div>
        <div><label for="ft">Turma</label><input id="ft" name="turma" list="dl-turmas" value="${esc(p.turma || '')}"></div>
        <div><label for="fc">Categoria</label><select id="fc" name="categoria">${opcoes(CATEGORIA_VISIVEL(), p.categoria, 'Todas')}</select></div>
        <div><label for="fs">Situação</label><select id="fs" name="status">${opcoes(STATUS, p.status, 'Todas')}</select></div>
        <div><label for="fde">De</label><input id="fde" type="date" name="de" value="${esc(p.de || '')}"></div>
        <div><label for="fate">Até</label><input id="fate" type="date" name="ate" value="${esc(p.ate || '')}"></div>
        <input type="hidden" name="aluno" value="${esc(p.aluno || '')}">
        <div class="acoes" style="margin:0;grid-column:1/-1">
          <button class="btn peq" type="submit">Filtrar</button>
          <a class="btn sec peq" href="#/ocorrencias">Limpar filtros</a>
        </div>
      </form>
      ${r.data.length ? `
      <div class="tabela-wrap"><table>
        <thead><tr><th>Nº</th><th>Data</th><th>Estudante</th><th>Turma</th><th>Tipo</th><th>Registrado por</th><th>Situação</th></tr></thead>
        <tbody>${r.data.map((o) => `
          <tr class="clicavel" data-id="${o.id}" tabindex="0">
            <td class="num">${o.id}</td><td>${dataBR(o.data_fato)}</td><td>${esc(o.aluno)}</td><td>${esc(o.turma)}</td>
            <td>${esc(o.tipo_nome)}${o.categoria === 'CONVIVA' ? '<br><span class="tag-conviva">Conviva</span>' : ''}</td>
            <td>${esc(o.autor_nome)}</td><td>${carimbo(o.status)}</td>
          </tr>`).join('')}</tbody>
      </table></div>
      <div class="paginacao">
        ${pagina > 1 ? `<a class="btn sec peq" href="#/ocorrencias?${qs({ ...p, pagina: pagina - 1 })}">Anterior</a>` : ''}
        <span class="muted">Página ${pagina} de ${paginas}</span>
        ${pagina < paginas ? `<a class="btn sec peq" href="#/ocorrencias?${qs({ ...p, pagina: pagina + 1 })}">Próxima</a>` : ''}
      </div>` : `<div class="folha"><p>Nenhuma ocorrência encontrada.</p>${pode('registrar') ? '<a class="btn" href="#/nova">Registrar ocorrência</a>' : ''}</div>`}`;

    $('#f-filtros').addEventListener('submit', (e) => {
      e.preventDefault();
      location.hash = '#/ocorrencias?' + qs(lerForm(e.target));
    });
    $$('tr.clicavel').forEach((tr) => {
      const ir = () => { location.hash = '#/ocorrencia/' + tr.dataset.id; };
      tr.addEventListener('click', ir);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') ir(); });
    });
  }

  /* ================= Nova ocorrência ================= */
  async function telaNova() {
    if (!pode('registrar')) throw new Error('Sua função não permite registrar ocorrências.');
    tipos = ok(await sb.from('tipos_ocorrencia').select('*').eq('ativo', true).order('nome'));
    conteudo.innerHTML = `
      <div class="cabecalho-pagina"><div><h1>Registrar ocorrência</h1>
      <p class="muted">Campos com * são obrigatórios. Ao salvar, Coordenação e Direção recebem o aviso na hora.</p></div></div>
      ${await sugestoes()}
      <form class="folha" id="f-nova">
        <div class="grade-3">
          <div><label class="obrig" for="n-data">Data do fato</label><input id="n-data" type="date" name="data_fato" max="${hoje()}" value="${hoje()}" required></div>
          <div><label class="obrig" for="n-turma">Turma</label><input id="n-turma" name="turma" list="dl-turmas" maxlength="40" placeholder="Ex.: 7º A" required></div>
          <div><label class="obrig" for="n-aluno">Estudante</label><input id="n-aluno" name="aluno" list="dl-alunos" maxlength="150" placeholder="Nome completo" required></div>
        </div>
        <div class="grade-3">
          <div><label class="obrig" for="n-cat">Categoria</label><select id="n-cat" required>${opcoes(CATEGORIA_VISIVEL(), '', 'Selecione')}</select></div>
          <div><label class="obrig" for="n-tipo">Tipo de ocorrência</label><select id="n-tipo" name="tipo_id" required><option value="">Escolha a categoria</option></select></div>
          <div><label for="n-status">Situação</label><select id="n-status" name="status">${opcoes(STATUS, 'ABERTA')}</select></div>
        </div>
        <label class="obrig" for="n-desc">Descrição do fato</label>
        <textarea id="n-desc" name="descricao" maxlength="5000" required placeholder="O que aconteceu, onde, quem estava presente. Descreva fatos, sem julgamentos."></textarea>
        <label class="obrig" for="n-prov">Providências adotadas</label>
        <textarea id="n-prov" name="providencias" maxlength="3000" required placeholder="Ex.: conversa com o estudante, contato com responsável, encaminhamento à Coordenação."></textarea>
        <p class="erro" id="n-erro" role="alert"></p>
        <div class="acoes"><button class="btn" type="submit">Salvar ocorrência</button><a class="btn sec" href="#/ocorrencias">Cancelar</a></div>
      </form>`;

    $('#n-cat').addEventListener('change', (e) => {
      const lista = tipos.filter((t) => t.categoria === e.target.value);
      $('#n-tipo').innerHTML = '<option value="">Selecione</option>' + lista.map((t) => `<option value="${t.id}">${esc(t.nome)}</option>`).join('');
    });
    $('#f-nova').addEventListener('submit', async (e) => {
      e.preventDefault();
      const botao = $('button[type=submit]', e.target);
      botao.disabled = true;
      try {
        const d = lerForm(e.target);
        const r = ok(await sb.from('ocorrencias').insert({
          data_fato: d.data_fato, turma: d.turma, aluno: d.aluno, tipo_id: Number(d.tipo_id),
          descricao: d.descricao, providencias: d.providencias, status: d.status,
        }).select('id').single());
        toast('Ocorrência registrada.');
        location.hash = '#/ocorrencia/' + r.id;
      } catch (err) {
        $('#n-erro').textContent = erroPT(err);
        botao.disabled = false;
      }
    });
  }

  /* ================= Detalhe + chat ================= */
  const SEL_MSG = '*, usuario:perfis(nome, funcao:funcoes(nome))';
  function htmlMensagem(m) {
    const u = m.usuario || {};
    return `<div class="msg ${m.usuario_id === eu.id ? 'minha' : ''}" data-id="${m.id}">
      <div class="quem">${esc(u.nome)}${u.funcao ? ` (${esc(u.funcao.nome)})` : ''} ${dataHora(m.criado_em)}</div>
      <div class="txt">${esc(m.texto)}</div></div>`;
  }
  function adicionarMensagem(m) {
    const caixa = $('#chat-msgs');
    if (!caixa || $(`.msg[data-id="${m.id}"]`, caixa)) return;
    const vazio = $('.vazio', caixa);
    if (vazio) vazio.remove();
    caixa.insertAdjacentHTML('beforeend', htmlMensagem(m));
    caixa.scrollTop = caixa.scrollHeight;
  }

  function assinarOcorrencia(id) {
    if (canalOc) sb.removeChannel(canalOc);
    canalOc = sb.channel('oc-' + id)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'mensagens', filter: `ocorrencia_id=eq.${id}` }, async (p) => {
        const r = await sb.from('mensagens').select(SEL_MSG).eq('id', p.new.id).maybeSingle();
        if (r.data && ocAtual === id) adicionarMensagem(r.data);
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'ocorrencias', filter: `id=eq.${id}` }, () => {
        if (ocAtual === id) telaDetalhe(id, true);
      })
      .subscribe();
  }

  async function telaDetalhe(id, atualizacao) {
    const o = ok(await sb.from('v_ocorrencias').select('*').eq('id', id).maybeSingle());
    if (!o) throw new Error('Ocorrência não encontrada.');
    const comChat = pode('conversar');
    const encerrada = o.status === 'ENCERRADA';
    const [historico, mensagens, totalAluno] = await Promise.all([
      sb.from('historico_status').select('*, usuario:perfis(nome)').eq('ocorrencia_id', id).order('id').then(ok),
      comChat ? sb.from('mensagens').select(SEL_MSG).eq('ocorrencia_id', id).order('id').then(ok) : Promise.resolve([]),
      sb.from('ocorrencias').select('id', { count: 'exact', head: true }).ilike('aluno', exato(o.aluno)).then((r) => r.count),
    ]);
    if (!atualizacao) {
      auditar('OCORRENCIA_VISUALIZADA', 'ocorrencia', id);
      sb.from('notificacoes').update({ lida: true }).eq('usuario_id', eu.id).eq('ocorrencia_id', id).eq('lida', false).then(() => {});
    }
    const rascunho = atualizacao && $('#chat-texto') ? $('#chat-texto').value : '';
    if (ocAtual !== id) { ocAtual = id; assinarOcorrencia(id); }

    const blocoChat = !comChat ? '' : `
        <section class="folha chat" aria-label="Conversa da equipe sobre esta ocorrência">
          <h3>Conversa da equipe</h3>
          <p class="muted">Fica registrada junto à ocorrência.</p>
          <div class="chat-msgs" id="chat-msgs" aria-live="polite">
            ${mensagens.length ? mensagens.map(htmlMensagem).join('') : '<p class="muted vazio">Ninguém comentou ainda.</p>'}
          </div>
          ${encerrada
            ? `<p class="chat-fechado">Ocorrência encerrada: a conversa foi fechada e fica só para consulta.${pode('acompanhar') ? ' Para conversar de novo, reabra a ocorrência mudando a situação.' : ''}</p>`
            : `<form id="f-chat">
                 <textarea id="chat-texto" maxlength="2000" placeholder="Escreva uma mensagem" aria-label="Mensagem"></textarea>
                 <button class="btn" type="submit">Enviar</button>
               </form>`}
        </section>`;

    conteudo.innerHTML = `
      <div class="cabecalho-pagina">
        <div><h1>Ocorrência nº ${o.id}</h1><p class="muted">Registrada por ${esc(o.autor_nome)}${o.autor_funcao ? ` (${esc(o.autor_funcao)})` : ''} em ${dataHora(o.criado_em)}</p></div>
        <div>${carimbo(o.status, true)}</div>
      </div>
      <div class="detalhe${comChat ? '' : ' sem-chat'}">
        <section class="folha dados">
          <dl>
            <dt>Estudante</dt><dd>${esc(o.aluno)}</dd>
            <dt>Turma</dt><dd>${esc(o.turma)}</dd>
            <dt>Data do fato</dt><dd>${dataBR(o.data_fato)}</dd>
            <dt>Categoria</dt><dd>${esc(CATEGORIA[o.categoria])}</dd>
            <dt>Tipo</dt><dd>${esc(o.tipo_nome)}</dd>
          </dl>
          <h2>Descrição do fato</h2><div class="texto-livre">${esc(o.descricao)}</div>
          <h2>Providências adotadas</h2><div class="texto-livre">${esc(o.providencias)}</div>
          <div class="acoes">
            ${pode('relatorios') ? '<button class="btn sec" type="button" id="b-pdf">Gerar PDF para prontuário</button>' : ''}
            <a class="btn sec" href="#/ocorrencias?${qs({ aluno: o.aluno })}">Histórico do estudante (${totalAluno == null ? '?' : totalAluno})</a>
          </div>
          ${pode('acompanhar') ? `
          <h2>Acompanhamento</h2>
          <form id="f-acomp">
            <div class="grade-2">
              <div><label for="a-status">Situação</label><select id="a-status" name="status">${opcoes(STATUS, o.status)}</select></div>
              <div><label for="a-obs">Observação</label><input id="a-obs" name="observacao" maxlength="1000" placeholder="Ex.: responsável compareceu à escola"></div>
            </div>
            <label for="a-prov">Providências (atualize se houver novas)</label>
            <textarea id="a-prov" name="providencias" maxlength="3000">${esc(o.providencias)}</textarea>
            ${comChat ? '<p class="muted">Ao encerrar, a conversa da equipe é fechada. Reabrir a ocorrência libera a conversa de novo.</p>' : ''}
            <p class="erro" id="a-erro" role="alert"></p>
            <button class="btn" type="submit">Salvar acompanhamento</button>
          </form>` : ''}
          <h2>Linha do tempo</h2>
          <ul class="linha-tempo">${historico.map((h) => `
            <li><strong>${esc(STATUS[h.status])}</strong> ${dataHora(h.criado_em)} por ${esc(h.usuario ? h.usuario.nome : '')}${h.observacao ? `<br><span class="muted">${esc(h.observacao)}</span>` : ''}</li>`).join('')}
          </ul>
        </section>
        ${blocoChat}
      </div>`;

    if ($('#chat-msgs')) $('#chat-msgs').scrollTop = $('#chat-msgs').scrollHeight;

    if ($('#f-chat')) {
      $('#chat-texto').value = rascunho;
      $('#f-chat').addEventListener('submit', async (e) => {
        e.preventDefault();
        const campo = $('#chat-texto');
        const texto = campo.value.trim();
        if (!texto) return;
        campo.value = '';
        try { adicionarMensagem(ok(await sb.from('mensagens').insert({ ocorrencia_id: id, texto }).select(SEL_MSG).single())); }
        catch (err) {
          campo.value = texto;
          toast(erroPT(err));
          if (/encerrada/i.test(err.message)) telaDetalhe(id, true);
        }
      });
      $('#chat-texto').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#f-chat').requestSubmit(); }
      });
    }

    if ($('#b-pdf')) {
      $('#b-pdf').addEventListener('click', () => {
        window.SisRoePDF.ficha(o, historico, escola, eu.nome);
        auditar('PDF_OCORRENCIA', 'ocorrencia', id);
      });
    }
    if ($('#f-acomp')) {
      $('#f-acomp').addEventListener('submit', async (e) => {
        e.preventDefault();
        const d = lerForm(e.target);
        if (d.status === 'ENCERRADA' && o.status !== 'ENCERRADA' && comChat &&
            !confirm('Encerrar a ocorrência? A conversa da equipe será fechada.')) return;
        try {
          ok(await sb.rpc('atualizar_ocorrencia', { p_id: id, p_status: d.status, p_providencias: d.providencias, p_observacao: d.observacao }));
          toast('Acompanhamento salvo.');
          telaDetalhe(id, true);
        } catch (err) { $('#a-erro').textContent = erroPT(err); }
      });
    }
  }

  /* ================= Painel ================= */
  function barras(lista, rotulo) {
    if (!lista || !lista.length) return '<p class="muted">Sem dados no período.</p>';
    const max = Math.max(...lista.map((i) => i.n));
    return `<ul class="barras">${lista.map((i) => `
      <li><span class="rot" title="${esc(rotulo(i.rotulo))}">${esc(rotulo(i.rotulo))}</span>
      <span class="trilho"><span class="valor" style="display:block;width:${(i.n / max) * 100}%"></span></span>
      <span class="n">${i.n}</span></li>`).join('')}</ul>`;
  }

  async function telaPainel(p) {
    if (!pode('painel')) throw new Error('Sua função não tem acesso ao painel.');
    const d = ok(await sb.rpc('painel', {
      p_de: p.de || null, p_ate: p.ate || null, p_turma: p.turma || null,
    }));
    const st = Object.fromEntries(d.por_status.map((s) => [s.rotulo, s.n]));
    const mes = (m) => { const [a, mm] = m.split('-'); return `${mm}/${a}`; };
    conteudo.innerHTML = `
      <div class="cabecalho-pagina"><div><h1>Painel</h1><p class="muted">Indicadores para planejar ações preventivas.</p></div></div>
      ${await sugestoes()}
      <form class="filtros" id="f-painel" style="grid-template-columns:repeat(4,1fr)">
        <div><label for="pde">De</label><input id="pde" type="date" name="de" value="${esc(p.de || '')}"></div>
        <div><label for="pate">Até</label><input id="pate" type="date" name="ate" value="${esc(p.ate || '')}"></div>
        <div><label for="pt">Turma</label><input id="pt" name="turma" list="dl-turmas" value="${esc(p.turma || '')}"></div>
        <div><button class="btn peq" type="submit">Atualizar</button></div>
      </form>
      <div class="numeros">
        <div class="numero"><b>${d.total}</b><span>ocorrências</span></div>
        <div class="numero"><b style="color:var(--vermelho)">${st.ABERTA || 0}</b><span>abertas</span></div>
        <div class="numero"><b style="color:var(--ambar)">${st.EM_ACOMPANHAMENTO || 0}</b><span>em acompanhamento</span></div>
        <div class="numero"><b style="color:var(--verde)">${st.ENCERRADA || 0}</b><span>encerradas</span></div>
      </div>
      <div class="graficos">
        <section class="folha"><h3>Por mês</h3>${barras(d.por_mes, mes)}</section>
        <section class="folha"><h3>Por categoria</h3>${barras(d.por_categoria, (c) => CATEGORIA[c])}</section>
        <section class="folha"><h3>Por tipo</h3>${barras(d.por_tipo, (t) => t)}</section>
        <section class="folha"><h3>Por turma</h3>${barras(d.por_turma, (t) => t)}</section>
      </div>
      <h2>Estudantes com mais ocorrências</h2>
      <p class="muted">Em destaque, quem tem ${d.limite_atencao} ou mais registros no período: avalie acompanhamento especial.</p>
      ${d.alunos.length ? `<div class="tabela-wrap"><table>
        <thead><tr><th>Estudante</th><th>Turma</th><th class="num">Total</th><th class="num">Não encerradas</th><th class="num">Conviva</th><th>Última</th></tr></thead>
        <tbody>${d.alunos.map((a) => `
          <tr class="clicavel" data-aluno="${esc(a.aluno)}" tabindex="0">
            <td class="${a.n >= d.limite_atencao ? 'atencao' : ''}">${esc(a.aluno)}${a.n >= d.limite_atencao ? ' (atenção)' : ''}</td>
            <td>${esc(a.turma)}</td><td class="num">${a.n}</td><td class="num">${a.em_aberto}</td><td class="num">${a.conviva}</td><td>${dataBR(a.ultima)}</td>
          </tr>`).join('')}</tbody></table></div>` : '<p class="muted">Sem dados no período.</p>'}`;

    $('#f-painel').addEventListener('submit', (e) => { e.preventDefault(); location.hash = '#/painel?' + qs(lerForm(e.target)); });
    $$('tr[data-aluno]').forEach((tr) => {
      const ir = () => { location.hash = '#/ocorrencias?' + qs({ aluno: tr.dataset.aluno }); };
      tr.addEventListener('click', ir);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') ir(); });
    });
  }

  /* ================= Relatórios ================= */
  async function telaRelatorios() {
    if (!pode('relatorios')) throw new Error('Sua função não tem acesso a relatórios.');
    const d = new Date();
    const inicioMes = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
    conteudo.innerHTML = `
      <div class="cabecalho-pagina"><div><h1>Relatórios</h1><p class="muted">Gere um PDF com todas as informações das ocorrências filtradas, pronto para imprimir ou enviar.</p></div></div>
      ${await sugestoes()}
      <form class="folha" id="f-rel">
        <div class="grade-2">
          <div><label for="rde">De</label><input id="rde" type="date" name="de" value="${inicioMes}"></div>
          <div><label for="rate">Até</label><input id="rate" type="date" name="ate" value="${hoje()}"></div>
          <div><label for="rt">Turma</label><input id="rt" name="turma" list="dl-turmas" placeholder="Todas"></div>
          <div><label for="ra">Estudante</label><input id="ra" name="aluno" list="dl-alunos" placeholder="Todos"></div>
          <div><label for="rc">Categoria</label><select id="rc" name="categoria">${opcoes(CATEGORIA_VISIVEL(), '', 'Todas')}</select></div>
          <div><label for="rs">Situação</label><select id="rs" name="status">${opcoes(STATUS, '', 'Todas')}</select></div>
        </div>
        <p class="erro" id="r-erro" role="alert"></p>
        <div class="acoes">
          <button class="btn" type="submit">Gerar PDF</button>
          <button class="btn sec" type="button" id="r-ano">Ano inteiro</button>
        </div>
      </form>`;
    $('#r-ano').addEventListener('click', () => {
      $('#rde').value = `${d.getFullYear()}-01-01`;
      $('#rate').value = hoje();
    });
    $('#f-rel').addEventListener('submit', async (e) => {
      e.preventDefault();
      const botao = $('button[type=submit]', e.target);
      botao.disabled = true;
      botao.textContent = 'Gerando…';
      try {
        const f = lerForm(e.target);
        const lista = [];
        for (let de = 0; ; de += 1000) { // o Supabase entrega até 1000 linhas por vez
          const lote = ok(await filtrar(sb.from('v_ocorrencias').select('*'), f)
            .order('data_fato').order('id').range(de, de + 999));
          lista.push(...lote);
          if (lote.length < 1000) break;
        }
        const partes = [];
        if (f.de || f.ate) partes.push(`Período: ${f.de ? dataBR(f.de) : 'início'} a ${f.ate ? dataBR(f.ate) : 'hoje'}`);
        if (f.turma) partes.push(`Turma: ${f.turma}`);
        if (f.aluno) partes.push(`Estudante: ${f.aluno}`);
        if (f.categoria) partes.push(`Categoria: ${CATEGORIA[f.categoria]}`);
        if (f.status) partes.push(`Situação: ${STATUS[f.status]}`);
        window.SisRoePDF.relatorio(lista, partes.length ? partes.join('   ') : 'Todas as ocorrências', escola, eu.nome);
        auditar('PDF_RELATORIO', null, null);
      } catch (err) {
        $('#r-erro').textContent = erroPT(err);
      } finally {
        botao.disabled = false;
        botao.textContent = 'Gerar PDF';
      }
    });
  }

  /* ================= Usuários (Direção) ================= */
  async function telaUsuarios() {
    if (!ehDirecao()) throw new Error('Somente a Direção gerencia usuários.');
    const [lista, funcoes] = await Promise.all([
      sb.rpc('listar_usuarios').then(ok),
      sb.from('funcoes').select('id, nome, direcao').order('direcao', { ascending: false }).order('nome').then(ok),
    ]);
    const opcoesFuncao = (sel, vazio) =>
      (vazio ? `<option value="">${esc(vazio)}</option>` : '') +
      funcoes.map((f) => `<option value="${f.id}" ${f.id === sel ? 'selected' : ''}>${esc(f.nome)}</option>`).join('');
    const pendentes = lista.filter((u) => !u.funcao_id).length;

    conteudo.innerHTML = `
      <div class="cabecalho-pagina"><div><h1>Usuários</h1><p class="muted">Cada pessoa entra com o próprio e-mail e vê o que a função dela permite. As funções são definidas em <a href="#/funcoes">Funções de acesso</a>.</p></div></div>
      <form class="folha" id="f-user">
        <h3>Cadastrar pessoa</h3>
        <div class="grade-3">
          <div><label class="obrig" for="u-nome">Nome</label><input id="u-nome" name="nome" maxlength="120" required></div>
          <div><label class="obrig" for="u-email">E-mail</label><input id="u-email" name="email" type="email" required></div>
          <div><label class="obrig" for="u-funcao">Função</label><select id="u-funcao" name="funcao" required>${opcoesFuncao(null, 'Selecione')}</select></div>
        </div>
        <p class="erro" id="u-erro" role="alert"></p>
        <button class="btn" type="submit">Cadastrar</button>
      </form>
      <div id="u-senha"></div>
      <h2>Equipe</h2>
      ${pendentes ? `<p class="atencao">${pendentes} pessoa(s) aguardando liberação: escolha uma função para liberar o acesso.</p>` : ''}
      <div class="tabela-wrap"><table>
        <thead><tr><th>Nome</th><th>E-mail</th><th>Função</th><th>Situação</th><th>Ações</th></tr></thead>
        <tbody>${lista.map((u) => `
          <tr data-id="${u.id}" data-nome="${esc(u.nome)}">
            <td>${esc(u.nome)}</td>
            <td>${esc(u.email)}</td>
            <td><select class="u-funcao" aria-label="Função de ${esc(u.nome)}" ${u.id === eu.id ? 'disabled' : ''}>${opcoesFuncao(u.funcao_id, u.funcao_id ? null : 'Aguardando liberação')}</select></td>
            <td>${u.ativo ? 'Ativo' : '<span class="atencao">Desativado</span>'}</td>
            <td>${u.id !== eu.id ? `<button class="btn ${u.ativo ? 'perigo' : 'sec'} peq" data-acao="ativo" data-valor="${u.ativo ? 0 : 1}">${u.ativo ? 'Desativar' : 'Reativar'}</button>` : ''}</td>
          </tr>`).join('')}</tbody></table></div>`;

    $('#f-user').addEventListener('submit', async (e) => {
      e.preventDefault();
      const botao = $('button[type=submit]', e.target);
      botao.disabled = true;
      try {
        const d = lerForm(e.target);
        // Cliente separado: cria a conta sem desconectar a Direção
        const tmp = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'sisroe-cadastro' },
        });
        const r = ok(await tmp.auth.signUp({ email: d.email.trim(), password: senhaDescartavel(), options: { data: { nome: d.nome.trim() } } }));
        if (!r.user || (r.user.identities && r.user.identities.length === 0)) throw new Error('Esse e-mail já está cadastrado.');
        ok(await sb.rpc('definir_funcao', { p_usuario: r.user.id, p_funcao: Number(d.funcao) }));
        await telaUsuarios();
        $('#u-senha').innerHTML = `<div class="aviso-ok"><strong>${esc(d.nome)}</strong> já pode entrar. No site, basta digitar <strong>${esc(d.email.trim())}</strong> e usar o código que chegar nesse e-mail.</div>`;
      } catch (err) {
        $('#u-erro').textContent = erroPT(err);
        botao.disabled = false;
      }
    });

    $$('tbody tr[data-id]').forEach((tr) => {
      const id = tr.dataset.id;
      const nome = tr.dataset.nome;
      $('.u-funcao', tr).addEventListener('change', async (e) => {
        if (!e.target.value) return;
        try {
          ok(await sb.rpc('definir_funcao', { p_usuario: id, p_funcao: Number(e.target.value) }));
          toast(`Função de ${nome} salva.`);
          telaUsuarios();
        } catch (err) { toast(erroPT(err)); telaUsuarios(); }
      });
      const b = $('button[data-acao="ativo"]', tr);
      if (b) b.addEventListener('click', async () => {
        if (!confirm(b.dataset.valor === '0' ? `Desativar o acesso de ${nome}?` : `Reativar o acesso de ${nome}?`)) return;
        try {
          ok(await sb.from('perfis').update({ ativo: b.dataset.valor === '1' }).eq('id', id));
          telaUsuarios();
        } catch (err) { toast(erroPT(err)); }
      });
    });
  }

  /* ================= Funções de acesso (Direção) ================= */
  async function telaFuncoes(editarId) {
    if (!ehDirecao()) throw new Error('Somente a Direção cria e altera funções.');
    const [funcoes, pessoas] = await Promise.all([
      sb.from('funcoes').select('*').order('direcao', { ascending: false }).order('nome').then(ok),
      sb.rpc('listar_usuarios').then(ok),
    ]);
    const qtd = (id) => pessoas.filter((u) => u.funcao_id === id).length;
    const resumo = (f) => {
      if (f.direcao) return 'Acesso total, inclusive usuários e funções.';
      const itens = PERMISSOES.filter(([k]) => f[k]).map(([, rot]) => rot.toLowerCase());
      const cats = f.categorias.map((c) => CATEGORIA[c].split(' (')[0]).join(', ');
      return `${itens.length ? itens.join('; ') : 'nenhuma permissão'}. Categorias: ${cats}.`;
    };
    const emEdicao = funcoes.find((f) => f.id === editarId && !f.direcao);
    const f0 = emEdicao || { nome: '', descricao: '', registrar: true, conversar: true, categorias: Object.keys(CATEGORIA) };

    conteudo.innerHTML = `
      <div class="cabecalho-pagina"><div><h1>Funções de acesso</h1>
        <p class="muted">Cada pessoa tem uma função, e a função define o que ela pode ver e fazer. Só a Direção cria e altera funções; a função Direção é fixa.</p></div>
        ${emEdicao ? '' : '<button class="btn" type="button" id="b-nova-funcao">Nova função</button>'}
      </div>

      <form class="folha ${emEdicao ? '' : 'oculto'}" id="f-funcao">
        <h3>${emEdicao ? `Editar função: ${esc(emEdicao.nome)}` : 'Nova função'}</h3>
        <div class="grade-2">
          <div><label class="obrig" for="fn-nome">Nome</label><input id="fn-nome" name="nome" maxlength="60" required value="${esc(f0.nome)}" placeholder="Ex.: Administrador, Psicólogo(a), Secretaria"></div>
          <div><label for="fn-desc">Descrição</label><input id="fn-desc" name="descricao" maxlength="300" value="${esc(f0.descricao)}" placeholder="Para que serve esta função"></div>
        </div>
        <label>O que esta função pode fazer</label>
        <ul class="permissoes">${PERMISSOES.map(([k, rot, ajuda]) => `
          <li><input type="checkbox" id="pm-${k}" name="${k}" ${f0[k] ? 'checked' : ''}>
              <label for="pm-${k}">${esc(rot)}${ajuda ? `<span class="muted">${esc(ajuda)}</span>` : ''}</label></li>`).join('')}
        </ul>
        <label style="margin-top:1rem">Categorias de ocorrência que esta função enxerga</label>
        <div class="categorias-check">${Object.entries(CATEGORIA).map(([c, rot]) => `
          <label><input type="checkbox" name="cat-${c}" ${f0.categorias.includes(c) ? 'checked' : ''}> ${esc(rot)}</label>`).join('')}
        </div>
        <p class="muted" style="margin-top:.6rem">Cadastrar pessoas e criar funções é sempre exclusivo da Direção.</p>
        <p class="erro" id="fn-erro" role="alert"></p>
        <div class="acoes">
          <button class="btn" type="submit">${emEdicao ? 'Salvar alterações' : 'Criar função'}</button>
          <button class="btn sec" type="button" id="b-cancelar-funcao">Cancelar</button>
        </div>
      </form>

      <h2>Funções cadastradas</h2>
      <div class="tabela-wrap"><table>
        <thead><tr><th>Função</th><th>Pode</th><th class="num">Pessoas</th><th>Ações</th></tr></thead>
        <tbody>${funcoes.map((f) => `
          <tr>
            <td><strong>${esc(f.nome)}</strong>${f.descricao ? `<br><span class="muted">${esc(f.descricao)}</span>` : ''}</td>
            <td class="resumo-perm">${esc(resumo(f))}</td>
            <td class="num">${qtd(f.id)}</td>
            <td>${f.direcao ? '<span class="muted">Fixa</span>' : `
              <button class="btn sec peq" data-editar="${f.id}">Editar</button>
              <button class="btn perigo peq" data-excluir="${f.id}" data-nome="${esc(f.nome)}" data-qtd="${qtd(f.id)}">Excluir</button>`}</td>
          </tr>`).join('')}</tbody>
      </table></div>`;

    const form = $('#f-funcao');
    if ($('#b-nova-funcao')) {
      $('#b-nova-funcao').addEventListener('click', () => {
        form.classList.remove('oculto');
        $('#b-nova-funcao').classList.add('oculto');
        $('#fn-nome').focus();
      });
    }
    $('#b-cancelar-funcao').addEventListener('click', () => telaFuncoes());

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const dados = { nome: fd.get('nome').trim(), descricao: fd.get('descricao').trim() };
      PERMISSOES.forEach(([k]) => { dados[k] = fd.get(k) === 'on'; });
      dados.categorias = Object.keys(CATEGORIA).filter((c) => fd.get('cat-' + c) === 'on');
      try {
        if (!dados.categorias.length) throw new Error('Marque pelo menos uma categoria de ocorrência.');
        if (emEdicao) ok(await sb.from('funcoes').update(dados).eq('id', emEdicao.id));
        else ok(await sb.from('funcoes').insert(dados));
        toast(emEdicao ? 'Função atualizada. Vale no próximo carregamento de página de quem a usa.' : 'Função criada. Já pode ser escolhida em Usuários.');
        telaFuncoes();
      } catch (err) {
        $('#fn-erro').textContent = /duplicate|unique/i.test(err.message) ? 'Já existe uma função com esse nome.' : erroPT(err);
      }
    });

    $$('button[data-editar]').forEach((b) => b.addEventListener('click', () => {
      telaFuncoes(Number(b.dataset.editar)).then(() => $('#fn-nome').focus());
    }));
    $$('button[data-excluir]').forEach((b) => b.addEventListener('click', async () => {
      if (Number(b.dataset.qtd) > 0) {
        toast(`Há ${b.dataset.qtd} pessoa(s) com a função ${b.dataset.nome}. Mude a função delas em Usuários antes de excluir.`);
        return;
      }
      if (!confirm(`Excluir a função ${b.dataset.nome}?`)) return;
      try { ok(await sb.from('funcoes').delete().eq('id', b.dataset.excluir)); telaFuncoes(); }
      catch (err) { toast(/foreign key|violates/i.test(err.message) ? 'Há pessoas com essa função. Mude a função delas antes de excluir.' : erroPT(err)); }
    }));
  }

  /* ================= Configurações ================= */
  async function telaConfiguracoes() {
    if (!pode('configuracoes')) throw new Error('Sua função não tem acesso às configurações.');
    const lista = ok(await sb.from('tipos_ocorrencia').select('*').order('nome'));
    conteudo.innerHTML = `
      <div class="cabecalho-pagina"><div><h1>Configurações</h1></div></div>
      <form class="folha" id="f-escola">
        <h3>Escola</h3>
        <div class="grade-2">
          <div><label class="obrig" for="c-nome">Nome da escola</label><input id="c-nome" name="escola_nome" maxlength="150" required value="${esc(escola.escola_nome)}"></div>
          <div><label for="c-end">Endereço (aparece nos PDFs)</label><input id="c-end" name="escola_endereco" maxlength="200" value="${esc(escola.escola_endereco)}"></div>
          <div><label for="c-lim">Destacar estudantes a partir de quantas ocorrências</label><input id="c-lim" name="limite_atencao" type="number" min="1" max="100" value="${escola.limite_atencao}"></div>
        </div>
        <p class="erro" id="c-erro" role="alert"></p>
        <button class="btn" type="submit">Salvar configurações</button>
      </form>

      <h2>Tipos de ocorrência</h2>
      <p class="muted">Ajuste a lista à realidade da escola e ao Protocolo Conviva vigente. Tipos desativados somem do formulário, mas os registros antigos continuam.</p>
      <form class="folha" id="f-tipo">
        <div class="grade-3">
          <div><label class="obrig" for="t-nome">Nome</label><input id="t-nome" name="nome" maxlength="80" required></div>
          <div><label class="obrig" for="t-cat">Categoria</label><select id="t-cat" name="categoria" required>${opcoes(CATEGORIA, '', 'Selecione')}</select></div>
          <div style="align-self:end"><button class="btn" type="submit">Adicionar tipo</button></div>
        </div>
        <p class="erro" id="t-erro" role="alert"></p>
      </form>
      ${Object.keys(CATEGORIA).map((c) => `
        <h2>${esc(CATEGORIA[c])}</h2>
        <div class="tabela-wrap"><table><tbody>
          ${lista.filter((t) => t.categoria === c).map((t) => `
            <tr><td>${esc(t.nome)}${t.ativo ? '' : ' <span class="muted">(desativado)</span>'}</td>
            <td style="text-align:right"><button class="btn sec peq" data-id="${t.id}" data-ativo="${t.ativo ? 0 : 1}">${t.ativo ? 'Desativar' : 'Reativar'}</button></td></tr>`).join('') || '<tr><td class="muted">Nenhum tipo.</td></tr>'}
        </tbody></table></div>`).join('')}`;

    $('#f-escola').addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = lerForm(e.target);
      try {
        ok(await sb.from('configuracoes').update({
          escola_nome: d.escola_nome.trim(), escola_endereco: d.escola_endereco.trim(),
          limite_atencao: Number(d.limite_atencao) || 3,
        }).eq('id', 1));
        await carregarEscola();
        toast('Configurações salvas.');
      } catch (err) { $('#c-erro').textContent = erroPT(err); }
    });
    $('#f-tipo').addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = lerForm(e.target);
      try {
        ok(await sb.from('tipos_ocorrencia').insert({ nome: d.nome.trim(), categoria: d.categoria }));
        telaConfiguracoes();
      } catch (err) {
        $('#t-erro').textContent = /duplicate|unique/i.test(err.message) ? 'Já existe um tipo com esse nome nessa categoria.' : erroPT(err);
      }
    });
    $$('button[data-id]').forEach((b) => b.addEventListener('click', async () => {
      try {
        ok(await sb.from('tipos_ocorrencia').update({ ativo: b.dataset.ativo === '1' }).eq('id', b.dataset.id));
        telaConfiguracoes();
      } catch (err) { toast(erroPT(err)); }
    }));
  }

  /* ================= Auditoria (Direção) ================= */
  const ACOES = ['LOGIN', 'LOGOUT', 'OCORRENCIA_CRIADA', 'OCORRENCIA_VISUALIZADA', 'OCORRENCIA_ATUALIZADA', 'MENSAGEM_ENVIADA',
    'PDF_OCORRENCIA', 'PDF_RELATORIO', 'SAIR_DE_TODOS',
    'USUARIO_FUNCAO', 'USUARIO_ATIVADO', 'USUARIO_DESATIVADO', 'FUNCAO_ALTERADA',
    'TIPO_ALTERADO', 'CONFIG_ALTERADA'];

  async function telaAuditoria(p) {
    if (!pode('auditoria')) throw new Error('Sua função não tem acesso à auditoria.');
    const pagina = Math.max(1, Number(p.pagina) || 1);
    const tam = 50;
    let q = sb.from('auditoria').select('*, usuario:perfis(nome)', { count: 'exact' });
    if (ACOES.includes(p.acao)) q = q.eq('acao', p.acao);
    const r = await q.order('id', { ascending: false }).range((pagina - 1) * tam, pagina * tam - 1);
    if (r.error) throw r.error;
    const paginas = Math.max(1, Math.ceil((r.count || 0) / tam));
    conteudo.innerHTML = `
      <div class="cabecalho-pagina"><div><h1>Auditoria</h1><p class="muted">Quem fez o quê e quando: acessos, registros, consultas, PDFs e mudanças de usuários.</p></div></div>
      <form class="filtros" id="f-aud" style="grid-template-columns:2fr 1fr">
        <div><label for="aa">Ação</label><select id="aa" name="acao"><option value="">Todas</option>${ACOES.map((a) => `<option ${a === p.acao ? 'selected' : ''}>${a}</option>`).join('')}</select></div>
        <div><button class="btn peq" type="submit">Filtrar</button></div>
      </form>
      <div class="tabela-wrap"><table>
        <thead><tr><th>Data</th><th>Usuário</th><th>Ação</th><th>Registro</th><th>Detalhes</th><th>IP</th></tr></thead>
        <tbody>${r.data.map((a) => `
          <tr><td>${dataHora(a.criado_em)}</td><td>${esc(a.usuario ? a.usuario.nome : '-')}</td><td>${esc(a.acao)}</td>
          <td>${a.entidade ? esc(a.entidade) + (a.entidade_id ? ' ' + esc(a.entidade_id) : '') : ''}</td>
          <td class="muted">${esc(a.detalhes ? JSON.stringify(a.detalhes) : '')}</td><td>${esc(a.ip || '')}</td></tr>`).join('')}</tbody>
      </table></div>
      <div class="paginacao">
        ${pagina > 1 ? `<a class="btn sec peq" href="#/auditoria?${qs({ ...p, pagina: pagina - 1 })}">Anterior</a>` : ''}
        <span class="muted">Página ${pagina} de ${paginas}</span>
        ${pagina < paginas ? `<a class="btn sec peq" href="#/auditoria?${qs({ ...p, pagina: pagina + 1 })}">Próxima</a>` : ''}
      </div>`;
    $('#f-aud').addEventListener('submit', (e) => { e.preventDefault(); location.hash = '#/auditoria?' + qs(lerForm(e.target)); });
  }

  /* ================= Minha conta ================= */
  async function telaConta() {
    conteudo.innerHTML = `
      <div class="cabecalho-pagina"><div><h1>Minha conta</h1></div></div>
      <section class="folha" style="max-width:560px">
        <div class="dados"><dl>
          <dt>Nome</dt><dd>${esc(eu.nome)}</dd>
          <dt>Função</dt><dd>${esc(eu.funcao.nome)}</dd>
          <dt>E-mail de acesso</dt><dd>${esc(eu.email)}</dd>
        </dl></div>
        <p class="muted" style="margin-top:1rem">Você entra digitando este e-mail e o código que chega nele. Proteja a sua caixa de e-mail: quem tiver acesso a ela consegue entrar no SisRoe.</p>
        <h2>Aparelhos conectados</h2>
        <p class="muted">Esqueceu o SisRoe aberto em outro computador ou perdeu o celular? Encerre o acesso em todos os aparelhos. Para voltar, basta pedir um novo código.</p>
        <button class="btn perigo" type="button" id="b-global">Sair de todos os aparelhos</button>
      </section>`;
    $('#b-global').addEventListener('click', async () => {
      if (!confirm('Encerrar o acesso em todos os aparelhos, inclusive neste?')) return;
      try { await auditar('SAIR_DE_TODOS', 'usuario', eu.id); } catch (e) { /* segue */ }
      await sb.auth.signOut({ scope: 'global' });
      location.hash = '';
      location.reload();
    });
  }

  /* ================= Início ================= */
  (async function iniciar() {
    if (!configurado) return mostrarEtapa('sem-config');
    try {
      await carregarEscola();
      await fluxo();
    } catch (err) {
      mostrarEtapa('f-login');
      $('#erro').textContent = erroPT(err);
    }
    sb.auth.onAuthStateChange((evento) => {
      if (evento === 'SIGNED_OUT' && !$('#tela-app').classList.contains('oculto')) {
        setTimeout(() => location.reload(), 0);
      }
    });
  })();
})();
