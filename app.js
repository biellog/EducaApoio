(function () {
  'use strict';

  /* ================= Utilitários ================= */
  const $ = (sel, raiz) => (raiz || document).querySelector(sel);
  const $$ = (sel, raiz) => Array.from((raiz || document).querySelectorAll(sel));
  const conteudo = $('#conteudo');

  const STATUS = { ABERTA: 'Aberta', EM_ACOMPANHAMENTO: 'Em acompanhamento', ENCERRADA: 'Encerrada' };
  const CATEGORIA = { ADMINISTRATIVA: 'Administrativa', PEDAGOGICA: 'Pedagógica', CONVIVA: 'Conviva (média gravidade)' };
  const PERFIL = { AOE: 'Agente de Organização Escolar', PROFESSOR: 'Professor(a)', COORDENACAO: 'Coordenação', DIRECAO: 'Direção' };
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
      [/Invalid login credentials/i, 'E-mail ou senha incorretos.'],
      [/already registered|already been registered/i, 'Esse e-mail já está cadastrado.'],
      [/Invalid TOTP code|invalid.*code/i, 'Código inválido. Confira o horário do celular e tente de novo.'],
      [/row-level security/i, 'Seu perfil não tem acesso a esta função.'],
      [/Password should be|weak password/i, 'Senha fraca. Use pelo menos 8 caracteres, com letras e números.'],
      [/rate limit|too many/i, 'Muitas tentativas. Aguarde alguns minutos.'],
      [/Failed to fetch|NetworkError/i, 'Sem conexão com o servidor. Verifique a internet.'],
      [/AAL2 required|aal2/i, 'Confirme a verificação em duas etapas primeiro.'],
      [/same_password|different from the old/i, 'A nova senha deve ser diferente da atual.'],
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

  function senhaProvisoria() {
    const a = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const v = crypto.getRandomValues(new Uint32Array(10));
    return Array.from(v, (n) => a[n % a.length]).join('') + '7';
  }
  function validarSenha(s) {
    if (s.length < 8) return 'A senha precisa ter pelo menos 8 caracteres.';
    if (!/[A-Za-z]/.test(s) || !/[0-9]/.test(s)) return 'Use letras e números na senha.';
    return null;
  }

  /* ================= Supabase ================= */
  const CFG = window.SISROE_CONFIG || {};
  const configurado = CFG.supabaseUrl && !/SEU-PROJETO/.test(CFG.supabaseUrl) && CFG.supabaseAnonKey && !/COLE-AQUI/.test(CFG.supabaseAnonKey);
  const sb = configurado ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey) : null;

  let escola = { escola_nome: 'Unidade Escolar', escola_endereco: '', exigir_2fa: true, limite_atencao: 3 };
  let eu = null;
  let tipos = [];
  let ocAtual = null;
  let canalOc = null;
  let veioDoLogin = false;

  const ehGestor = () => eu && ['COORDENACAO', 'DIRECAO'].includes(eu.perfil);
  const ehDirecao = () => eu && eu.perfil === 'DIRECAO';
  const auditar = (acao, entidade, id) =>
    sb.rpc('auditar', { p_acao: acao, p_entidade: entidade || null, p_id: id != null ? String(id) : null }).then(() => {});

  async function carregarEscola() {
    const r = await sb.from('configuracoes').select('*').eq('id', 1).maybeSingle();
    if (r.data) escola = r.data;
    $('#escola-login').textContent = escola.escola_nome;
    $('#escola-app').textContent = escola.escola_nome;
    document.title = 'SisRoe | ' + escola.escola_nome;
  }

  /* ================= Entrada (login em etapas) ================= */
  const ETAPAS = ['carregando', 'sem-config', 'f-login', 'f-totp', 'f-senha', 'f-2fa', 'aguardando'];
  function mostrarEtapa(id) {
    $('#tela-app').classList.add('oculto');
    $('#tela-login').classList.remove('oculto');
    ETAPAS.forEach((e) => $('#' + e).classList.toggle('oculto', e !== id));
    $('#erro').textContent = '';
    const campo = $('#' + id + ' input');
    if (campo) campo.focus();
  }

  // Decide em que etapa a pessoa está e avança
  async function fluxo() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return mostrarEtapa('f-login');

    const aal = ok(await sb.auth.mfa.getAuthenticatorAssuranceLevel());
    if (aal.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') return mostrarEtapa('f-totp');

    const meu = ok(await sb.from('perfis').select('*').eq('id', session.user.id).maybeSingle());
    if (!meu) return mostrarEtapa('aguardando');
    if (meu.trocar_senha) return mostrarEtapa('f-senha');
    if (escola.exigir_2fa && aal.currentLevel !== 'aal2') return iniciarCadastro2FA('#qr', '#segredo').then(() => mostrarEtapa('f-2fa'));
    if (!meu.perfil || !meu.ativo) return mostrarEtapa('aguardando');

    eu = meu;
    if (veioDoLogin) { auditar('LOGIN', 'usuario', eu.id); veioDoLogin = false; }
    iniciarApp();
  }

  let fatorPendente = null;
  async function iniciarCadastro2FA(seletorQr, seletorSegredo) {
    const fatores = ok(await sb.auth.mfa.listFactors());
    for (const f of fatores.all.filter((x) => x.status !== 'verified')) {
      await sb.auth.mfa.unenroll({ factorId: f.id });
    }
    const r = ok(await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'SisRoe ' + Date.now() }));
    fatorPendente = r.id;
    $(seletorQr).src = r.totp.qr_code;
    $(seletorSegredo).textContent = r.totp.secret;
  }
  async function confirmar2FA(codigo) {
    ok(await sb.auth.mfa.challengeAndVerify({ factorId: fatorPendente, code: codigo.replace(/\s/g, '') }));
    fatorPendente = null;
    auditar('2FA_ATIVADO', 'usuario');
  }

  function aoEnviar(formId, acao) {
    $('#' + formId).addEventListener('submit', async (e) => {
      e.preventDefault();
      const botao = $('button[type=submit]', e.target);
      botao.disabled = true;
      $('#erro').textContent = '';
      try {
        await acao();
        await fluxo();
      } catch (err) {
        $('#erro').textContent = erroPT(err);
      } finally {
        botao.disabled = false;
      }
    });
  }

  aoEnviar('f-login', async () => {
    ok(await sb.auth.signInWithPassword({ email: $('#email').value.trim(), password: $('#senha').value }));
    $('#senha').value = '';
    veioDoLogin = true;
  });
  aoEnviar('f-totp', async () => {
    const fatores = ok(await sb.auth.mfa.listFactors());
    const f = fatores.totp[0];
    if (!f) throw new Error('Nenhum aplicativo autenticador cadastrado. Peça à Direção para refazer o duplo fator.');
    ok(await sb.auth.mfa.challengeAndVerify({ factorId: f.id, code: $('#codigo').value.replace(/\s/g, '') }));
    $('#codigo').value = '';
  });
  aoEnviar('f-senha', async () => {
    const nova = $('#nova').value;
    if (nova !== $('#nova2').value) throw new Error('As senhas não são iguais.');
    const erro = validarSenha(nova);
    if (erro) throw new Error(erro);
    ok(await sb.auth.updateUser({ password: nova }));
    ok(await sb.rpc('senha_trocada'));
    $('#nova').value = ''; $('#nova2').value = '';
  });
  aoEnviar('f-2fa', async () => {
    await confirmar2FA($('#codigo2').value);
    $('#codigo2').value = '';
  });

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
    if (!location.hash) location.hash = ehGestor() ? '#/painel' : '#/ocorrencias';
    else rotear();
  }

  function montarMenu() {
    const itens = [
      ['#/ocorrencias', ehGestor() ? 'Ocorrências' : 'Minhas ocorrências', true],
      ['#/nova', 'Registrar ocorrência', true],
      ['#/painel', 'Painel', ehGestor()],
      ['#/relatorios', 'Relatórios', ehGestor()],
      ['#/usuarios', 'Usuários', ehDirecao()],
      ['#/configuracoes', 'Configurações', ehDirecao()],
      ['#/auditoria', 'Auditoria', ehDirecao()],
      ['#/conta', 'Minha conta', true],
    ];
    $('#menu').innerHTML = itens.filter((i) => i[2]).map(([h, t]) => `<a href="${h}">${esc(t)}</a>`).join('');
    $('#nome-usuario').textContent = eu.nome;
    $('#perfil-usuario').textContent = PERFIL[eu.perfil];
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
    const titulo = p.aluno ? `Histórico de ${p.aluno}` : ehGestor() ? 'Ocorrências' : 'Minhas ocorrências';

    conteudo.innerHTML = `
      <div class="cabecalho-pagina">
        <div><h1>${esc(titulo)}</h1><p class="muted">${total} registro(s)</p></div>
        <a class="btn" href="#/nova">Registrar ocorrência</a>
      </div>
      ${await sugestoes()}
      <form class="filtros" id="f-filtros">
        <div><label for="fq">Buscar estudante, turma ou texto</label><input id="fq" name="q" value="${esc(p.q || '')}" placeholder="Digite o nome do estudante"></div>
        <div><label for="ft">Turma</label><input id="ft" name="turma" list="dl-turmas" value="${esc(p.turma || '')}"></div>
        <div><label for="fc">Categoria</label><select id="fc" name="categoria">${opcoes(CATEGORIA, p.categoria, 'Todas')}</select></div>
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
      </div>` : '<div class="folha"><p>Nenhuma ocorrência encontrada.</p><a class="btn" href="#/nova">Registrar ocorrência</a></div>'}`;

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
          <div><label class="obrig" for="n-cat">Categoria</label><select id="n-cat" required>${opcoes(CATEGORIA, '', 'Selecione')}</select></div>
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
  const SEL_MSG = '*, usuario:perfis(nome, perfil)';
  function htmlMensagem(m) {
    const u = m.usuario || {};
    return `<div class="msg ${m.usuario_id === eu.id ? 'minha' : ''}" data-id="${m.id}">
      <div class="quem">${esc(u.nome)} (${esc(PERFIL[u.perfil] || '')}) ${dataHora(m.criado_em)}</div>
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
    const [historico, mensagens, totalAluno] = await Promise.all([
      sb.from('historico_status').select('*, usuario:perfis(nome)').eq('ocorrencia_id', id).order('id').then(ok),
      sb.from('mensagens').select(SEL_MSG).eq('ocorrencia_id', id).order('id').then(ok),
      ehGestor()
        ? sb.from('ocorrencias').select('id', { count: 'exact', head: true }).ilike('aluno', exato(o.aluno)).then((r) => r.count)
        : Promise.resolve(null),
    ]);
    if (!atualizacao) {
      auditar('OCORRENCIA_VISUALIZADA', 'ocorrencia', id);
      sb.from('notificacoes').update({ lida: true }).eq('usuario_id', eu.id).eq('ocorrencia_id', id).eq('lida', false).then(() => {});
    }
    const rascunho = atualizacao && $('#chat-texto') ? $('#chat-texto').value : '';
    if (ocAtual !== id) { ocAtual = id; assinarOcorrencia(id); }

    conteudo.innerHTML = `
      <div class="cabecalho-pagina">
        <div><h1>Ocorrência nº ${o.id}</h1><p class="muted">Registrada por ${esc(o.autor_nome)} em ${dataHora(o.criado_em)}</p></div>
        <div>${carimbo(o.status, true)}</div>
      </div>
      <div class="detalhe">
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
          ${ehGestor() ? `
          <div class="acoes">
            <button class="btn sec" type="button" id="b-pdf">Gerar PDF para prontuário</button>
            <a class="btn sec" href="#/ocorrencias?${qs({ aluno: o.aluno })}">Histórico do estudante (${totalAluno})</a>
          </div>
          <h2>Acompanhamento</h2>
          <form id="f-acomp">
            <div class="grade-2">
              <div><label for="a-status">Situação</label><select id="a-status" name="status">${opcoes(STATUS, o.status)}</select></div>
              <div><label for="a-obs">Observação</label><input id="a-obs" name="observacao" maxlength="1000" placeholder="Ex.: responsável compareceu à escola"></div>
            </div>
            <label for="a-prov">Providências (atualize se houver novas)</label>
            <textarea id="a-prov" name="providencias" maxlength="3000">${esc(o.providencias)}</textarea>
            <p class="erro" id="a-erro" role="alert"></p>
            <button class="btn" type="submit">Salvar acompanhamento</button>
          </form>` : ''}
          <h2>Linha do tempo</h2>
          <ul class="linha-tempo">${historico.map((h) => `
            <li><strong>${esc(STATUS[h.status])}</strong> ${dataHora(h.criado_em)} por ${esc(h.usuario ? h.usuario.nome : '')}${h.observacao ? `<br><span class="muted">${esc(h.observacao)}</span>` : ''}</li>`).join('')}
          </ul>
        </section>

        <section class="folha chat" aria-label="Conversa da equipe sobre esta ocorrência">
          <h3>Conversa da equipe</h3>
          <p class="muted">Fica registrada junto à ocorrência.</p>
          <div class="chat-msgs" id="chat-msgs" aria-live="polite">
            ${mensagens.length ? mensagens.map(htmlMensagem).join('') : '<p class="muted vazio">Ninguém comentou ainda.</p>'}
          </div>
          <form id="f-chat">
            <textarea id="chat-texto" maxlength="2000" placeholder="Escreva uma mensagem" aria-label="Mensagem"></textarea>
            <button class="btn" type="submit">Enviar</button>
          </form>
        </section>
      </div>`;

    const caixa = $('#chat-msgs');
    caixa.scrollTop = caixa.scrollHeight;
    $('#chat-texto').value = rascunho;

    $('#f-chat').addEventListener('submit', async (e) => {
      e.preventDefault();
      const campo = $('#chat-texto');
      const texto = campo.value.trim();
      if (!texto) return;
      campo.value = '';
      try { adicionarMensagem(ok(await sb.from('mensagens').insert({ ocorrencia_id: id, texto }).select(SEL_MSG).single())); }
      catch (err) { campo.value = texto; toast(erroPT(err)); }
    });
    $('#chat-texto').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#f-chat').requestSubmit(); }
    });

    if ($('#b-pdf')) {
      $('#b-pdf').addEventListener('click', () => {
        window.SisRoePDF.ficha(o, historico, escola, eu.nome);
        auditar('PDF_OCORRENCIA', 'ocorrencia', id);
      });
      $('#f-acomp').addEventListener('submit', async (e) => {
        e.preventDefault();
        const d = lerForm(e.target);
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
          <div><label for="rc">Categoria</label><select id="rc" name="categoria">${opcoes(CATEGORIA, '', 'Todas')}</select></div>
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
    const lista = ok(await sb.rpc('listar_usuarios'));
    conteudo.innerHTML = `
      <div class="cabecalho-pagina"><div><h1>Usuários</h1><p class="muted">Cada pessoa entra com o próprio e-mail e vê apenas o que compete à sua função.</p></div></div>
      <form class="folha" id="f-user">
        <h3>Cadastrar pessoa</h3>
        <div class="grade-3">
          <div><label class="obrig" for="u-nome">Nome</label><input id="u-nome" name="nome" maxlength="120" required></div>
          <div><label class="obrig" for="u-email">E-mail</label><input id="u-email" name="email" type="email" required></div>
          <div><label class="obrig" for="u-perfil">Perfil</label><select id="u-perfil" name="perfil" required>${opcoes(PERFIL, '', 'Selecione')}</select></div>
        </div>
        <p class="erro" id="u-erro" role="alert"></p>
        <button class="btn" type="submit">Cadastrar</button>
      </form>
      <div id="u-senha"></div>
      <h2>Equipe</h2>
      <div class="tabela-wrap"><table>
        <thead><tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th>Duplo fator</th><th>Situação</th><th>Ações</th></tr></thead>
        <tbody>${lista.map((u) => `
          <tr data-id="${u.id}" data-nome="${esc(u.nome)}">
            <td>${esc(u.nome)}${u.trocar_senha ? '<br><span class="muted">aguardando 1º acesso</span>' : ''}</td>
            <td>${esc(u.email)}</td>
            <td><select class="u-perfil" aria-label="Perfil de ${esc(u.nome)}" ${u.id === eu.id ? 'disabled' : ''}>${opcoes(PERFIL, u.perfil, u.perfil ? null : 'Aguardando liberação')}</select></td>
            <td>${u.duplo_fator ? 'Ativo' : 'Não configurado'}</td>
            <td>${u.ativo ? 'Ativo' : '<span class="atencao">Desativado</span>'}</td>
            <td>
              ${u.id !== eu.id ? `<button class="btn sec peq" data-acao="senha">Nova senha</button>` : ''}
              ${u.duplo_fator && u.id !== eu.id ? '<button class="btn sec peq" data-acao="2fa">Refazer duplo fator</button>' : ''}
              ${u.id !== eu.id ? `<button class="btn ${u.ativo ? 'perigo' : 'sec'} peq" data-acao="ativo" data-valor="${u.ativo ? 0 : 1}">${u.ativo ? 'Desativar' : 'Reativar'}</button>` : ''}
            </td>
          </tr>`).join('')}</tbody></table></div>`;

    const mostrarSenha = (nome, email, senha) => {
      $('#u-senha').innerHTML = `<div class="aviso-ok">Acesso de <strong>${esc(nome)}</strong>: e-mail ${esc(email)}, senha provisória <span class="segredo">${esc(senha)}</span><br>
        Entregue pessoalmente. Ela só aparece agora e será trocada no primeiro acesso.</div>`;
    };

    $('#f-user').addEventListener('submit', async (e) => {
      e.preventDefault();
      const botao = $('button[type=submit]', e.target);
      botao.disabled = true;
      try {
        const d = lerForm(e.target);
        const senha = senhaProvisoria();
        // Cliente separado: cria a conta sem desconectar a Direção
        const tmp = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'sisroe-cadastro' },
        });
        const r = ok(await tmp.auth.signUp({ email: d.email.trim(), password: senha, options: { data: { nome: d.nome.trim() } } }));
        if (!r.user || (r.user.identities && r.user.identities.length === 0)) throw new Error('Esse e-mail já está cadastrado.');
        ok(await sb.rpc('definir_perfil', { p_usuario: r.user.id, p_perfil: d.perfil, p_trocar_senha: true }));
        await telaUsuarios();
        mostrarSenha(d.nome, d.email, senha);
      } catch (err) {
        $('#u-erro').textContent = erroPT(err);
        botao.disabled = false;
      }
    });

    $$('tbody tr[data-id]').forEach((tr) => {
      const id = tr.dataset.id;
      const nome = tr.dataset.nome;
      $('.u-perfil', tr).addEventListener('change', async (e) => {
        try {
          ok(await sb.rpc('definir_perfil', { p_usuario: id, p_perfil: e.target.value }));
          toast('Perfil salvo.');
          telaUsuarios();
        } catch (err) { toast(erroPT(err)); telaUsuarios(); }
      });
      $$('button[data-acao]', tr).forEach((b) => b.addEventListener('click', async () => {
        const acao = b.dataset.acao;
        const pergunta = {
          senha: `Gerar nova senha provisória para ${nome}?`,
          '2fa': `${nome} terá de configurar o duplo fator de novo no próximo acesso. Continuar?`,
          ativo: b.dataset.valor === '0' ? `Desativar o acesso de ${nome}?` : `Reativar o acesso de ${nome}?`,
        }[acao];
        if (!confirm(pergunta)) return;
        try {
          if (acao === 'senha') {
            const senha = ok(await sb.rpc('redefinir_senha', { p_usuario: id }));
            await telaUsuarios();
            mostrarSenha(nome, tr.cells[1].textContent, senha);
          } else if (acao === '2fa') {
            ok(await sb.rpc('resetar_2fa', { p_usuario: id }));
            telaUsuarios();
          } else {
            ok(await sb.from('perfis').update({ ativo: b.dataset.valor === '1' }).eq('id', id));
            telaUsuarios();
          }
        } catch (err) { toast(erroPT(err)); }
      }));
    });
  }

  /* ================= Configurações (Direção) ================= */
  async function telaConfiguracoes() {
    const lista = ok(await sb.from('tipos_ocorrencia').select('*').order('nome'));
    conteudo.innerHTML = `
      <div class="cabecalho-pagina"><div><h1>Configurações</h1></div></div>
      <form class="folha" id="f-escola">
        <h3>Escola</h3>
        <div class="grade-2">
          <div><label class="obrig" for="c-nome">Nome da escola</label><input id="c-nome" name="escola_nome" maxlength="150" required value="${esc(escola.escola_nome)}"></div>
          <div><label for="c-end">Endereço (aparece nos PDFs)</label><input id="c-end" name="escola_endereco" maxlength="200" value="${esc(escola.escola_endereco)}"></div>
          <div><label for="c-lim">Destacar estudantes a partir de quantas ocorrências</label><input id="c-lim" name="limite_atencao" type="number" min="1" max="100" value="${escola.limite_atencao}"></div>
          <div><label for="c-2fa">Verificação em duas etapas</label>
            <select id="c-2fa" name="exigir_2fa"><option value="true" ${escola.exigir_2fa ? 'selected' : ''}>Obrigatória para todos (recomendado)</option><option value="false" ${escola.exigir_2fa ? '' : 'selected'}>Opcional</option></select></div>
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
          limite_atencao: Number(d.limite_atencao) || 3, exigir_2fa: d.exigir_2fa === 'true',
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
    'PDF_OCORRENCIA', 'PDF_RELATORIO', 'SENHA_DEFINIDA', 'SENHA_ALTERADA', '2FA_ATIVADO', '2FA_DESATIVADO',
    'USUARIO_PERFIL', 'USUARIO_ATIVADO', 'USUARIO_DESATIVADO', 'USUARIO_SENHA_RESETADA', 'USUARIO_2FA_RESETADO',
    'TIPO_ALTERADO', 'CONFIG_ALTERADA'];

  async function telaAuditoria(p) {
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
    const fatores = ok(await sb.auth.mfa.listFactors());
    const ativo = fatores.totp.length > 0;
    conteudo.innerHTML = `
      <div class="cabecalho-pagina"><div><h1>Minha conta</h1><p class="muted">${esc(eu.nome)}, ${esc(PERFIL[eu.perfil])}, ${esc(eu.email)}</p></div></div>
      <div class="grade-2" style="gap:1rem">
        <form class="folha" id="f-minha-senha">
          <h3>Trocar senha</h3>
          <label for="s-nova">Nova senha</label><input id="s-nova" type="password" autocomplete="new-password" minlength="8" required>
          <label for="s-nova2">Repita a nova senha</label><input id="s-nova2" type="password" autocomplete="new-password" minlength="8" required>
          <p class="erro" id="s-erro" role="alert"></p>
          <button class="btn" type="submit">Salvar senha</button>
        </form>
        <section class="folha">
          <h3>Verificação em duas etapas</h3>
          ${ativo
            ? `<p>Ativa. Cada acesso pede o código do aplicativo autenticador.</p>
               ${escola.exigir_2fa ? '<p class="muted">Obrigatória nesta escola. Se trocar de celular, peça à Direção para refazer.</p>'
                 : '<p class="erro" id="d-erro"></p><button class="btn perigo" id="b-desativar" type="button">Desativar</button>'}`
            : `<p>Desativada. Ative para proteger os dados dos estudantes.</p>
               <button class="btn" type="button" id="b-ativar">Ativar</button>
               <div id="ativar-2fa" class="oculto">
                 <img id="c-qr" class="qr" alt="QR Code para o aplicativo autenticador" width="220" height="220">
                 <p id="c-seg" class="segredo"></p>
                 <label for="c-cod">Código do aplicativo</label><input id="c-cod" inputmode="numeric" maxlength="6">
                 <p class="erro" id="c-erro"></p>
                 <button class="btn" type="button" id="b-confirmar">Confirmar</button>
               </div>`}
        </section>
      </div>`;

    $('#f-minha-senha').addEventListener('submit', async (e) => {
      e.preventDefault();
      const nova = $('#s-nova').value;
      try {
        if (nova !== $('#s-nova2').value) throw new Error('As senhas não são iguais.');
        const erro = validarSenha(nova);
        if (erro) throw new Error(erro);
        ok(await sb.auth.updateUser({ password: nova }));
        auditar('SENHA_ALTERADA', 'usuario', eu.id);
        e.target.reset();
        toast('Senha alterada.');
      } catch (err) { $('#s-erro').textContent = erroPT(err); }
    });
    if ($('#b-ativar')) {
      $('#b-ativar').addEventListener('click', async () => {
        try {
          await iniciarCadastro2FA('#c-qr', '#c-seg');
          $('#ativar-2fa').classList.remove('oculto');
          $('#b-ativar').classList.add('oculto');
        } catch (err) { toast(erroPT(err)); }
      });
      $('#b-confirmar').addEventListener('click', async () => {
        try { await confirmar2FA($('#c-cod').value); toast('Verificação em duas etapas ativada.'); telaConta(); }
        catch (err) { $('#c-erro').textContent = erroPT(err); }
      });
    }
    if ($('#b-desativar')) {
      $('#b-desativar').addEventListener('click', async () => {
        if (!confirm('Desativar a verificação em duas etapas?')) return;
        try {
          for (const f of fatores.totp) ok(await sb.auth.mfa.unenroll({ factorId: f.id }));
          auditar('2FA_DESATIVADO', 'usuario', eu.id);
          telaConta();
        } catch (err) { $('#d-erro').textContent = erroPT(err); }
      });
    }
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
