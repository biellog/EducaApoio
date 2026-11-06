(function () {
  'use strict';

  /* ================= Utilitários ================= */
  const $ = (sel, raiz) => (raiz || document).querySelector(sel);
  const $$ = (sel, raiz) => Array.from((raiz || document).querySelectorAll(sel));
  const conteudo = $('#conteudo');

  const STATUS = { ABERTA: 'Aberta', EM_ACOMPANHAMENTO: 'Em acompanhamento', ENCERRADA: 'Encerrada' };
  // Categorias: carregadas do banco ao entrar (estas são só o padrão inicial)
  let CATEGORIA = { ADMINISTRATIVA: 'Administrativa', PEDAGOGICA: 'Pedagógica', CONVIVA: 'Conviva (média gravidade)' };
  let CATEGORIAS = Object.entries(CATEGORIA).map(([id, nome]) => ({ id, nome, ativo: true, descricao: '' }));
  const nomeCategoria = (id) => CATEGORIA[id] || id || '';
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
      [/Payload too large|exceeded the maximum allowed size|entity too large/i, 'Arquivo grande demais. O limite é 10 MB.'],
      [/mime type.*not supported|invalid_mime_type/i, 'Tipo de arquivo não aceito. Envie foto (JPG, PNG) ou PDF.'],
      [/Bucket not found/i, 'O armazenamento de anexos não foi configurado. Rode o arquivo migracao-anexos.sql no Supabase.'],
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

  /* ================= Anexos (fotos e PDF) ================= */
  const TIPOS_ANEXO = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
  const MAX_ANEXO = 10 * 1024 * 1024; // 10 MB
  const ACEITA_ANEXO = 'image/*,application/pdf';
  const tamanhoTexto = (b) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);
  const ehImagem = (tipo) => /^image\//.test(tipo);

  // Reduz a foto (lado maior até 1600 px, JPEG) para economizar espaço sem perder a leitura
  function comprimirImagem(arquivo) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(arquivo);
      const img = new Image();
      img.onload = () => {
        const max = 1600;
        const escala = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * escala);
        c.height = Math.round(img.naturalHeight * escala);
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob((b) => (b ? resolve(b) : reject(new Error('Não foi possível preparar a foto.'))), 'image/jpeg', 0.82);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error(`Não foi possível abrir a foto "${arquivo.name}". Tente tirar de novo ou salvar em JPG.`));
      };
      img.src = url;
    });
  }

  function nomeSeguro(nome) {
    return String(nome || 'arquivo').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 150);
  }

  // Envia um arquivo para a ocorrência: guarda o arquivo e depois o registro
  async function enviarAnexo(ocId, arquivo) {
    const pdf = arquivo.type === 'application/pdf' || /\.pdf$/i.test(arquivo.name);
    if (!pdf && !/^image\//.test(arquivo.type)) throw new Error(`"${arquivo.name}" não é foto nem PDF.`);
    let blob = arquivo;
    let tipo = 'application/pdf';
    let nome = nomeSeguro(arquivo.name);
    if (!pdf) {
      blob = await comprimirImagem(arquivo);
      tipo = 'image/jpeg';
      nome = nome.replace(/\.[^.]+$/, '') + '.jpg';
    }
    if (blob.size > MAX_ANEXO) throw new Error(`"${arquivo.name}" passa de 10 MB. Envie um arquivo menor.`);
    const caminho = `${ocId}/${crypto.randomUUID()}.${pdf ? 'pdf' : 'jpg'}`;
    const up = await sb.storage.from('anexos').upload(caminho, blob, { contentType: tipo, upsert: false });
    if (up.error) throw new Error(erroPT(up.error));
    const ins = await sb.from('anexos').insert({ ocorrencia_id: ocId, caminho, nome, tipo, tamanho: blob.size });
    if (ins.error) {
      await sb.storage.from('anexos').remove([caminho]);
      throw new Error(erroPT(ins.error));
    }
  }

  async function enviarVarios(ocId, arquivos, aoProgresso) {
    const falhas = [];
    for (let i = 0; i < arquivos.length; i++) {
      if (aoProgresso) aoProgresso(i + 1, arquivos.length);
      try { await enviarAnexo(ocId, arquivos[i]); } catch (e) { falhas.push(e.message); }
    }
    return falhas;
  }

  // Lê um arquivo do armazenamento como imagem para o PDF (com medidas)
  async function imagemParaPdf(url) {
    const blob = await (await fetch(url)).blob();
    const dataUrl = await new Promise((ok2, erro) => {
      const fr = new FileReader();
      fr.onload = () => ok2(fr.result);
      fr.onerror = erro;
      fr.readAsDataURL(blob);
    });
    const dim = await new Promise((ok2) => {
      const im = new Image();
      im.onload = () => ok2({ w: im.naturalWidth, h: im.naturalHeight });
      im.onerror = () => ok2(null);
      im.src = dataUrl;
    });
    return dim ? { dataUrl, ...dim } : null;
  }

  /* ================= Supabase ================= */
  const CFG = window.EDUCAAPOIO_CONFIG || window.SISROE_CONFIG || {}; // aceita o config.js antigo
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
  const categoriasVisiveis = (soAtivas) =>
    CATEGORIAS.filter((c) => (!soAtivas || c.ativo) && (ehDirecao() || (eu.funcao.categorias || []).includes(c.id))).map((c) => c.id);
  const CATEGORIA_VISIVEL = (soAtivas) => Object.fromEntries(categoriasVisiveis(soAtivas).map((c) => [c, CATEGORIA[c]]));
  async function carregarCategorias() {
    const r = await sb.from('categorias').select('*').order('criado_em').order('id');
    if (!r.error && r.data && r.data.length) {
      CATEGORIAS = r.data;
      CATEGORIA = Object.fromEntries(r.data.map((c) => [c.id, c.nome]));
    }
  }
  const auditar = (acao, entidade, id) =>
    sb.rpc('auditar', { p_acao: acao, p_entidade: entidade || null, p_id: id != null ? String(id) : null }).then(() => {});

  async function carregarEscola() {
    const r = await sb.from('configuracoes').select('*').eq('id', 1).maybeSingle();
    if (r.data) escola = r.data;
    $('#escola-login').textContent = escola.escola_nome;
    $('#escola-app').textContent = escola.escola_nome;
    atualizarTitulo();
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
    await carregarCategorias();
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
    if (!location.hash) location.hash = '#/inicio';
    else rotear();
  }

  function montarMenu() {
    const itens = [
      ['#/inicio', 'Início', true],
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

  /* ================= Som e título dos avisos ================= */
  const SOM_AVISO = new Audio('som-aviso.mp3');
  SOM_AVISO.preload = 'auto';
  SOM_AVISO.volume = 0.8;
  const CHAVE_SOM = 'educaapoio-som';
  function somLigado() {
    try { return localStorage.getItem(CHAVE_SOM) !== 'desligado'; } catch (e) { return true; }
  }
  function definirSom(ligado) {
    try { localStorage.setItem(CHAVE_SOM, ligado ? 'ligado' : 'desligado'); } catch (e) { /* sem armazenamento */ }
  }
  function tocarSom(forcar) {
    if (!forcar && !somLigado()) return;
    try {
      SOM_AVISO.currentTime = 0;
      const t = SOM_AVISO.play();
      if (t && t.catch) t.catch(() => { /* o navegador só libera o som depois de um clique na página */ });
    } catch (e) { /* segue sem som */ }
  }
  // O navegador só deixa tocar som depois que a pessoa clica na página: no 1º clique, o som é "destravado"
  function destravarSom() {
    SOM_AVISO.muted = true;
    const t = SOM_AVISO.play();
    const fim = () => { SOM_AVISO.pause(); SOM_AVISO.currentTime = 0; SOM_AVISO.muted = false; };
    if (t && t.then) t.then(fim, fim); else fim();
  }
  document.addEventListener('pointerdown', destravarSom, { once: true });
  document.addEventListener('keydown', destravarSom, { once: true });

  let avisosNaoLidos = 0;
  function atualizarTitulo() {
    document.title = (avisosNaoLidos ? `(${avisosNaoLidos}) ` : '') + 'EducaApoio | ' + escola.escola_nome;
  }

  /* ================= Avisos em tempo real ================= */
  async function carregarNotificacoes() {
    const itens = ok(await sb.from('notificacoes').select('*').order('id', { ascending: false }).limit(30));
    const naoLidas = itens.filter((i) => !i.lida).length;
    avisosNaoLidos = naoLidas;
    atualizarTitulo();
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
      avisosNaoLidos = 0;
      atualizarTitulo();
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
        avisosNaoLidos += 1;
        atualizarTitulo();
        if (!(ocAtual === n.ocorrencia_id && /comentou/.test(n.texto))) {
          toast(n.texto, () => { location.hash = '#/ocorrencia/' + n.ocorrencia_id; });
          tocarSom();
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
        case 'inicio': return await telaInicio();
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
    if (p.categoria && CATEGORIA[p.categoria]) q = q.eq('categoria', p.categoria);
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
  /* ================= Início ================= */
  async function telaInicio() {
    const contar = (status) => {
      let q = sb.from('v_ocorrencias').select('id', { count: 'exact', head: true }).eq('status', status);
      if (!pode('ver_todas')) q = q.eq('autor_id', eu.id);
      return q.then((r) => r.count || 0);
    };
    const [abertas, acomp] = await Promise.all([contar('ABERTA'), contar('EM_ACOMPANHAMENTO')]);
    const primeiroNome = String(eu.nome || '').split(' ')[0];
    const hora = new Date().getHours();
    const saudacao = hora < 12 ? 'Bom dia' : hora < 18 ? 'Boa tarde' : 'Boa noite';
    const atalho = (href, titulo, texto, destaque) =>
      `<a class="atalho${destaque ? ' destaque' : ''}" href="${href}"><strong>${esc(titulo)}</strong><span>${esc(texto)}</span></a>`;
    conteudo.innerHTML = `
      <div class="cabecalho-pagina"><div><h1>${saudacao}, ${esc(primeiroNome)}!</h1>
        <p class="muted">O que você quer fazer agora?</p></div></div>
      <div class="atalhos">
        ${pode('registrar') ? atalho('#/nova', 'Registrar ocorrência', 'Anotar um fato novo, com fotos se precisar.', true) : ''}
        ${atalho('#/ocorrencias', pode('ver_todas') ? 'Ver ocorrências' : 'Minhas ocorrências', 'Procurar pelo nome do estudante ou pela turma.')}
        ${pode('painel') ? atalho('#/painel', 'Painel', 'Números por mês, turma e tipo.') : ''}
        ${pode('relatorios') ? atalho('#/relatorios', 'Relatórios', 'Gerar PDF para imprimir ou enviar.') : ''}
      </div>
      <div class="numeros numeros-2">
        <a class="numero" href="#/ocorrencias?status=ABERTA"><b style="color:var(--vermelho)">${abertas}</b><span>abertas${pode('ver_todas') ? '' : ' (suas)'}</span></a>
        <a class="numero" href="#/ocorrencias?status=EM_ACOMPANHAMENTO"><b style="color:var(--ambar)">${acomp}</b><span>em acompanhamento${pode('ver_todas') ? '' : ' (suas)'}</span></a>
      </div>
      <p class="muted">Dica: clique em <strong>Avisos</strong>, no alto da tela, para ver as novidades das ocorrências.</p>`;
  }

  /* ================= Nova ocorrência ================= */
  async function telaNova() {
    if (!pode('registrar')) throw new Error('Sua função não permite registrar ocorrências.');
    tipos = ok(await sb.from('tipos_ocorrencia').select('*').eq('ativo', true).order('nome'));
    const cats = CATEGORIA_VISIVEL(true);
    conteudo.innerHTML = `
      <a class="voltar" href="#/inicio">&larr; Voltar</a>
      <div class="cabecalho-pagina"><div><h1>Registrar ocorrência</h1>
      <p class="muted">Preencha as 4 partes. Os campos com <span class="obrig-ex">*</span> são obrigatórios.</p></div></div>
      ${await sugestoes()}
      <form id="f-nova">
        <fieldset class="etapa">
          <legend><span class="num">1</span> Quem e quando</legend>
          <div class="grade-3">
            <div><label class="obrig" for="n-data">Data do fato</label><input id="n-data" type="date" name="data_fato" max="${hoje()}" value="${hoje()}" required></div>
            <div><label class="obrig" for="n-turma">Turma</label><input id="n-turma" name="turma" list="dl-turmas" maxlength="40" placeholder="Ex.: 7º A" required></div>
            <div><label class="obrig" for="n-aluno">Estudante</label><input id="n-aluno" name="aluno" list="dl-alunos" maxlength="150" placeholder="Nome completo" required></div>
          </div>
        </fieldset>
        <fieldset class="etapa">
          <legend><span class="num">2</span> O que aconteceu</legend>
          <div class="grade-2">
            <div><label class="obrig" for="n-cat">Categoria</label><select id="n-cat" required>${opcoes(cats, Object.keys(cats).length === 1 ? Object.keys(cats)[0] : '', Object.keys(cats).length === 1 ? null : 'Escolha a categoria')}</select></div>
            <div><label class="obrig" for="n-tipo">Tipo de ocorrência</label><select id="n-tipo" name="tipo_id" required disabled><option value="">Escolha primeiro a categoria</option></select></div>
          </div>
          <label class="obrig" for="n-desc">Descrição do fato</label>
          <textarea id="n-desc" name="descricao" maxlength="5000" required placeholder="O que aconteceu, onde e quem estava presente. Escreva os fatos, sem opiniões."></textarea>
        </fieldset>
        <fieldset class="etapa">
          <legend><span class="num">3</span> O que foi feito</legend>
          <label class="obrig" for="n-prov">Providências adotadas</label>
          <textarea id="n-prov" name="providencias" maxlength="3000" required placeholder="Ex.: conversei com o estudante e avisei a Coordenação."></textarea>
          <label for="n-status">Situação</label>
          <select id="n-status" name="status" style="max-width:320px">${opcoes(STATUS, 'ABERTA')}</select>
        </fieldset>
        <fieldset class="etapa">
          <legend><span class="num">4</span> Fotos ou PDF <span class="muted">(se tiver)</span></legend>
          <label class="btn sec" for="n-anexos">Escolher fotos ou PDF</label>
          <input id="n-anexos" type="file" accept="${ACEITA_ANEXO}" multiple class="oculto">
          <p class="muted">Ex.: foto da carteira quebrada. No celular, dá para tirar a foto na hora.</p>
          <ul class="lista-arquivos" id="n-lista"></ul>
        </fieldset>
        <p class="erro" id="n-erro" role="alert"></p>
        <div class="acoes acoes-grandes"><button class="btn grande" type="submit">Salvar ocorrência</button><a class="btn sec grande" href="#/inicio">Cancelar</a></div>
      </form>`;

    const preencherTipos = () => {
      const cat = $('#n-cat').value;
      const lista = tipos.filter((t) => t.categoria === cat);
      const sel = $('#n-tipo');
      sel.disabled = !cat;
      sel.innerHTML = !cat ? '<option value="">Escolha primeiro a categoria</option>'
        : (lista.length ? '<option value="">Escolha o tipo</option>' + lista.map((t) => `<option value="${t.id}">${esc(t.nome)}</option>`).join('')
                        : '<option value="">Nenhum tipo cadastrado nesta categoria</option>');
    };
    $('#n-cat').addEventListener('change', preencherTipos);
    preencherTipos();
    $('#n-anexos').addEventListener('change', (e) => {
      $('#n-lista').innerHTML = Array.from(e.target.files).map((f) => `<li>${esc(f.name)} <span class="muted">(${tamanhoTexto(f.size)})</span></li>`).join('');
    });
    $('#f-nova').addEventListener('submit', async (e) => {
      e.preventDefault();
      const botao = $('button[type=submit]', e.target);
      botao.disabled = true;
      botao.textContent = 'Salvando…';
      try {
        const d = lerForm(e.target);
        const arquivos = Array.from($('#n-anexos').files);
        const r = ok(await sb.from('ocorrencias').insert({
          data_fato: d.data_fato, turma: d.turma, aluno: d.aluno, tipo_id: Number(d.tipo_id),
          descricao: d.descricao, providencias: d.providencias, status: d.status,
        }).select('id').single());
        if (arquivos.length) {
          const falhas = await enviarVarios(r.id, arquivos, (i, n) => { botao.textContent = `Enviando anexo ${i} de ${n}…`; });
          if (falhas.length) alert('A ocorrência foi salva, mas alguns anexos não foram enviados:\n\n' + falhas.join('\n') + '\n\nVocê pode anexá-los de novo na tela da ocorrência.');
        }
        toast('Ocorrência registrada.');
        location.hash = '#/ocorrencia/' + r.id;
      } catch (err) {
        $('#n-erro').textContent = erroPT(err);
        botao.disabled = false;
        botao.textContent = 'Salvar ocorrência';
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
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'anexos', filter: `ocorrencia_id=eq.${id}` }, () => {
        if (ocAtual === id && !$('#d-anexo-status')?.textContent) telaDetalhe(id, true);
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
    const [historico, mensagens, totalAluno, anexos] = await Promise.all([
      sb.from('historico_status').select('*, usuario:perfis(nome)').eq('ocorrencia_id', id).order('id').then(ok),
      comChat ? sb.from('mensagens').select(SEL_MSG).eq('ocorrencia_id', id).order('id').then(ok) : Promise.resolve([]),
      sb.from('ocorrencias').select('id', { count: 'exact', head: true }).ilike('aluno', exato(o.aluno)).then((r) => r.count),
      sb.from('anexos').select('*, usuario:perfis(nome)').eq('ocorrencia_id', id).order('id').then(ok),
    ]);
    // Links temporários (1 hora) para mostrar os arquivos privados
    if (anexos.length) {
      const urls = await sb.storage.from('anexos').createSignedUrls(anexos.map((a) => a.caminho), 3600);
      (urls.data || []).forEach((u, i) => { if (anexos[i]) anexos[i].url = u.signedUrl; });
    }
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
      <a class="voltar" href="#/ocorrencias">&larr; Voltar para a lista</a>
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
            <dt>Categoria</dt><dd>${esc(o.categoria_nome || nomeCategoria(o.categoria))}</dd>
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
          <h2>Anexos</h2>
          ${anexos.length ? `<ul class="anexos">${anexos.map((a, i) => `
            <li>
              ${a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener" data-abrir="${a.id}">` : '<span>'}
                ${ehImagem(a.tipo) && a.url ? `<img src="${esc(a.url)}" alt="${esc(a.nome)}" loading="lazy">` : '<span class="icone-pdf">PDF</span>'}
              ${a.url ? '</a>' : '</span>'}
              <span class="anexo-nome">${esc(a.nome)}</span>
              <span class="muted">${esc(a.usuario ? a.usuario.nome : '')}, ${dataHora(a.criado_em)}, ${tamanhoTexto(a.tamanho)}</span>
              ${ehDirecao() ? `<button class="link" type="button" data-remover="${i}">Excluir</button>` : ''}
            </li>`).join('')}</ul>` : '<p class="muted">Nenhum anexo.</p>'}
          ${encerrada
            ? '<p class="muted">Ocorrência encerrada: não recebe mais anexos.</p>'
            : `<label class="btn sec" for="d-anexos" style="width:auto">Adicionar foto ou PDF</label>
               <input id="d-anexos" type="file" accept="${ACEITA_ANEXO}" multiple class="oculto">
               <p class="muted" id="d-anexo-status"></p>`}
          <h2>Linha do tempo</h2>
          <ul class="linha-tempo">${historico.map((h) => `
            <li><strong>${esc(STATUS[h.status])}</strong> ${dataHora(h.criado_em)} por ${esc(h.usuario ? h.usuario.nome : '')}${h.observacao ? `<br><span class="muted">${esc(h.observacao)}</span>` : ''}</li>`).join('')}
          </ul>
        </section>
        ${blocoChat}
      </div>
      ${ehDirecao() ? `
      <section class="zona-perigo" id="zona-excluir">
        <h3>Excluir ocorrência</h3>
        <p class="muted">Apaga a ocorrência, a conversa, a linha do tempo e os anexos. Não dá para desfazer. Fica registrado na Auditoria quem apagou, quando e por quê.</p>
        <button class="btn perigo" type="button" id="b-excluir">Excluir esta ocorrência</button>
        <div id="confirmar-exclusao" class="oculto">
          <label class="obrig" for="ex-motivo">Por que esta ocorrência vai ser excluída?</label>
          <textarea id="ex-motivo" maxlength="500" placeholder="Ex.: registrada em duplicidade; aluno errado."></textarea>
          <p class="erro" id="ex-erro" role="alert"></p>
          <div class="acoes">
            <button class="btn perigo-cheio" type="button" id="b-confirmar-exclusao">Sim, excluir definitivamente</button>
            <button class="btn sec" type="button" id="b-cancelar-exclusao">Não, voltar</button>
          </div>
        </div>
      </section>` : ''}`;

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

    $$('a[data-abrir]').forEach((a) => a.addEventListener('click', () => auditar('ANEXO_ABERTO', 'ocorrencia', id)));

    if ($('#b-excluir')) {
      $('#b-excluir').addEventListener('click', () => {
        $('#confirmar-exclusao').classList.remove('oculto');
        $('#b-excluir').classList.add('oculto');
        $('#ex-motivo').focus();
      });
      $('#b-cancelar-exclusao').addEventListener('click', () => {
        $('#confirmar-exclusao').classList.add('oculto');
        $('#b-excluir').classList.remove('oculto');
        $('#ex-erro').textContent = '';
      });
      $('#b-confirmar-exclusao').addEventListener('click', async () => {
        const motivo = $('#ex-motivo').value.trim();
        if (motivo.length < 5) { $('#ex-erro').textContent = 'Escreva o motivo da exclusão.'; return; }
        if (!confirm(`Última confirmação: excluir a ocorrência nº ${id} de ${o.aluno}?`)) return;
        const b = $('#b-confirmar-exclusao');
        b.disabled = true;
        b.textContent = 'Excluindo…';
        try {
          if (anexos.length) {
            const rem = await sb.storage.from('anexos').remove(anexos.map((a) => a.caminho));
            if (rem.error) throw new Error(erroPT(rem.error));
          }
          ok(await sb.rpc('excluir_ocorrencia', { p_id: id, p_motivo: motivo }));
          if (canalOc) sb.removeChannel(canalOc);
          canalOc = null;
          ocAtual = null;
          toast(`Ocorrência nº ${id} excluída.`);
          location.hash = '#/ocorrencias';
        } catch (err) {
          $('#ex-erro').textContent = erroPT(err);
          b.disabled = false;
          b.textContent = 'Sim, excluir definitivamente';
        }
      });
    }

    if ($('#d-anexos')) {
      $('#d-anexos').addEventListener('change', async (e) => {
        const arquivos = Array.from(e.target.files);
        if (!arquivos.length) return;
        const status = $('#d-anexo-status');
        const falhas = await enviarVarios(id, arquivos, (i, n) => { status.textContent = `Enviando ${i} de ${n}…`; });
        status.textContent = '';
        if (falhas.length) toast(falhas.join(' '));
        else toast(arquivos.length > 1 ? 'Anexos enviados.' : 'Anexo enviado.');
        telaDetalhe(id, true);
      });
    }

    $$('button[data-remover]').forEach((b) => b.addEventListener('click', async () => {
      const a = anexos[Number(b.dataset.remover)];
      if (!confirm(`Excluir o anexo "${a.nome}"? Não dá para desfazer.`)) return;
      try {
        ok(await sb.from('anexos').delete().eq('id', a.id));
        await sb.storage.from('anexos').remove([a.caminho]);
        toast('Anexo excluído.');
        telaDetalhe(id, true);
      } catch (err) { toast(erroPT(err)); }
    }));

    if ($('#b-pdf')) {
      $('#b-pdf').addEventListener('click', async () => {
        const b = $('#b-pdf');
        b.disabled = true;
        b.textContent = 'Gerando PDF…';
        try {
          const lista = [];
          for (const a of anexos) {
            const item = { nome: a.nome, tipo: a.tipo, usuario: a.usuario ? a.usuario.nome : '', criado_em: a.criado_em };
            if (ehImagem(a.tipo) && a.url) {
              try { Object.assign(item, await imagemParaPdf(a.url)); } catch (e2) { /* segue sem a imagem */ }
            }
            lista.push(item);
          }
          window.EducaApoioPDF.ficha(o, historico, escola, eu.nome, lista);
          auditar('PDF_OCORRENCIA', 'ocorrencia', id);
        } catch (err) {
          toast(erroPT(err));
        } finally {
          b.disabled = false;
          b.textContent = 'Gerar PDF para prontuário';
        }
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
        <section class="folha"><h3>Por categoria</h3>${barras(d.por_categoria, (c) => nomeCategoria(c))}</section>
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
        if (f.categoria) partes.push(`Categoria: ${nomeCategoria(f.categoria)}`);
        if (f.status) partes.push(`Situação: ${STATUS[f.status]}`);
        window.EducaApoioPDF.relatorio(lista, partes.length ? partes.join('   ') : 'Todas as ocorrências', escola, eu.nome);
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
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'educaapoio-cadastro' },
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
      const cats = f.categorias.map((c) => nomeCategoria(c).split(' (')[0]).join(', ');
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
        <div class="categorias-check">${CATEGORIAS.map((c) => `
          <label><input type="checkbox" name="cat-${c.id}" ${f0.categorias.includes(c.id) ? 'checked' : ''}> ${esc(c.nome)}${c.ativo ? '' : ' <span class="muted">(desativada)</span>'}</label>`).join('')}
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
    await carregarCategorias();
    const [lista, funcoes] = await Promise.all([
      sb.from('tipos_ocorrencia').select('*').order('nome').then(ok),
      ehDirecao() ? sb.from('funcoes').select('id, nome, direcao, ver_todas').order('nome').then(ok) : Promise.resolve([]),
    ]);
    const originais = ['ADMINISTRATIVA', 'PEDAGOGICA', 'CONVIVA'];

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
        <button class="btn" type="submit">Salvar dados da escola</button>
      </form>

      <div class="cabecalho-pagina" style="margin-top:2rem"><div><h2 style="margin:0">Categorias e tipos de ocorrência</h2>
        <p class="muted">Cada categoria agrupa tipos de ocorrência. Tipos ou categorias desativados somem do formulário, mas os registros antigos continuam.</p></div>
        ${ehDirecao() ? '<button class="btn" type="button" id="b-nova-cat">Nova categoria</button>' : ''}
      </div>

      ${ehDirecao() ? `
      <form class="folha oculto" id="f-cat">
        <h3>Nova categoria</h3>
        <div class="grade-2">
          <div><label class="obrig" for="cat-nome">Nome da categoria</label><input id="cat-nome" name="nome" maxlength="60" required placeholder="Ex.: Saúde, Família, Transporte escolar"></div>
          <div><label for="cat-desc">Descrição (opcional)</label><input id="cat-desc" name="descricao" maxlength="200" placeholder="Para que serve esta categoria"></div>
        </div>
        <label>Quais funções vão enxergar esta categoria?</label>
        <div class="categorias-check">${funcoes.filter((f) => !f.direcao).map((f) => `
          <label><input type="checkbox" name="fn-${f.id}" ${f.ver_todas ? 'checked' : ''}> ${esc(f.nome)}</label>`).join('')}
        </div>
        <p class="muted">A Direção sempre enxerga todas. Depois de criar, cadastre os tipos de ocorrência dentro dela.</p>
        <p class="erro" id="cat-erro" role="alert"></p>
        <div class="acoes"><button class="btn" type="submit">Criar categoria</button><button class="btn sec" type="button" id="b-cancelar-cat">Cancelar</button></div>
      </form>` : ''}

      ${CATEGORIAS.map((c) => `
        <section class="folha bloco-categoria${c.ativo ? '' : ' inativa'}" data-cat="${esc(c.id)}">
          <div class="cab-categoria">
            <div>
              <h3>${esc(c.nome)}${c.ativo ? '' : ' <span class="muted">(desativada)</span>'}</h3>
              ${c.descricao ? `<p class="muted">${esc(c.descricao)}</p>` : ''}
            </div>
            ${ehDirecao() ? `<div class="acoes-cat">
              <button class="btn sec peq" type="button" data-renomear="${esc(c.id)}">Renomear</button>
              <button class="btn sec peq" type="button" data-ativar-cat="${esc(c.id)}" data-valor="${c.ativo ? 0 : 1}">${c.ativo ? 'Desativar' : 'Reativar'}</button>
              ${originais.includes(c.id) ? '' : `<button class="btn perigo peq" type="button" data-excluir-cat="${esc(c.id)}">Excluir</button>`}
            </div>` : ''}
          </div>
          <ul class="lista-tipos">
            ${lista.filter((t) => t.categoria === c.id).map((t) => `
              <li><span>${esc(t.nome)}${t.ativo ? '' : ' <span class="muted">(desativado)</span>'}</span>
                  <button class="btn sec peq" type="button" data-id="${t.id}" data-ativo="${t.ativo ? 0 : 1}">${t.ativo ? 'Desativar' : 'Reativar'}</button></li>`).join('') || '<li class="muted">Nenhum tipo ainda.</li>'}
          </ul>
          <form class="f-tipo-cat" data-cat="${esc(c.id)}">
            <input name="nome" maxlength="80" required placeholder="Novo tipo nesta categoria" aria-label="Novo tipo em ${esc(c.nome)}">
            <button class="btn peq" type="submit">Adicionar tipo</button>
          </form>
        </section>`).join('')}`;

    $('#f-escola').addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = lerForm(e.target);
      try {
        ok(await sb.from('configuracoes').update({
          escola_nome: d.escola_nome.trim(), escola_endereco: d.escola_endereco.trim(),
          limite_atencao: Number(d.limite_atencao) || 3,
        }).eq('id', 1));
        await carregarEscola();
        toast('Dados da escola salvos.');
      } catch (err) { $('#c-erro').textContent = erroPT(err); }
    });

    $$('form.f-tipo-cat').forEach((f) => f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const nome = f.nome.value.trim();
      if (!nome) return;
      try {
        ok(await sb.from('tipos_ocorrencia').insert({ nome, categoria: f.dataset.cat }));
        toast('Tipo adicionado.');
        telaConfiguracoes();
      } catch (err) {
        toast(/duplicate|unique/i.test(err.message) ? 'Já existe um tipo com esse nome nessa categoria.' : erroPT(err));
      }
    }));
    $$('button[data-id]').forEach((b) => b.addEventListener('click', async () => {
      try {
        ok(await sb.from('tipos_ocorrencia').update({ ativo: b.dataset.ativo === '1' }).eq('id', b.dataset.id));
        telaConfiguracoes();
      } catch (err) { toast(erroPT(err)); }
    }));

    if (!ehDirecao()) return;
    const fc = $('#f-cat');
    $('#b-nova-cat').addEventListener('click', () => {
      fc.classList.remove('oculto');
      $('#b-nova-cat').classList.add('oculto');
      $('#cat-nome').focus();
    });
    $('#b-cancelar-cat').addEventListener('click', () => telaConfiguracoes());
    fc.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(fc);
      const ids = funcoes.filter((f) => !f.direcao && fd.get('fn-' + f.id) === 'on').map((f) => f.id);
      try {
        ok(await sb.rpc('criar_categoria', { p_nome: fd.get('nome').trim(), p_descricao: fd.get('descricao').trim(), p_funcoes: ids }));
        toast('Categoria criada. Agora cadastre os tipos de ocorrência dela.');
        telaConfiguracoes();
      } catch (err) { $('#cat-erro').textContent = erroPT(err); }
    });
    $$('button[data-renomear]').forEach((b) => b.addEventListener('click', async () => {
      const id = b.dataset.renomear;
      const novo = prompt('Novo nome da categoria:', CATEGORIA[id] || '');
      if (!novo || !novo.trim() || novo.trim() === CATEGORIA[id]) return;
      try {
        ok(await sb.from('categorias').update({ nome: novo.trim() }).eq('id', id));
        toast('Categoria renomeada.');
        telaConfiguracoes();
      } catch (err) { toast(/duplicate|unique/i.test(err.message) ? 'Já existe uma categoria com esse nome.' : erroPT(err)); }
    }));
    $$('button[data-ativar-cat]').forEach((b) => b.addEventListener('click', async () => {
      const id = b.dataset.ativarCat;
      const ativar = b.dataset.valor === '1';
      if (!ativar && !confirm(`Desativar a categoria "${CATEGORIA[id]}"? Ela some do formulário de registro, mas as ocorrências antigas continuam.`)) return;
      try {
        ok(await sb.from('categorias').update({ ativo: ativar }).eq('id', id));
        telaConfiguracoes();
      } catch (err) { toast(erroPT(err)); }
    }));
    $$('button[data-excluir-cat]').forEach((b) => b.addEventListener('click', async () => {
      const id = b.dataset.excluirCat;
      if (!confirm(`Excluir a categoria "${CATEGORIA[id]}"?`)) return;
      try {
        ok(await sb.from('categorias').delete().eq('id', id));
        toast('Categoria excluída.');
        telaConfiguracoes();
      } catch (err) { toast(erroPT(err)); }
    }));
  }

  /* ================= Auditoria (Direção) ================= */
  const ACOES = ['LOGIN', 'LOGOUT', 'OCORRENCIA_CRIADA', 'OCORRENCIA_VISUALIZADA', 'OCORRENCIA_ATUALIZADA', 'MENSAGEM_ENVIADA',
    'PDF_OCORRENCIA', 'PDF_RELATORIO', 'SAIR_DE_TODOS', 'ANEXO_ADICIONADO', 'ANEXO_ABERTO', 'ANEXO_REMOVIDO', 'OCORRENCIA_EXCLUIDA', 'CATEGORIA_CRIADA', 'CATEGORIA_ALTERADA',
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
        <p class="muted" style="margin-top:1rem">Você entra digitando este e-mail e o código que chega nele. Proteja a sua caixa de e-mail: quem tiver acesso a ela consegue entrar no EducaApoio.</p>
        <h2>Som dos avisos</h2>
        <p class="muted">Toca um som curto quando chega um aviso novo, como uma ocorrência registrada ou um comentário.</p>
        <div class="acoes" style="margin-top:.4rem">
          <button class="btn ${somLigado() ? '' : 'sec'}" type="button" id="b-som">${somLigado() ? 'Som ligado' : 'Som desligado'}</button>
          <button class="btn sec" type="button" id="b-testar-som">Testar som</button>
        </div>
        <p class="muted" style="margin-top:.6rem">Não ouviu? Confira o volume do computador e se a aba do navegador não está sem som.</p>
        <h2>Aparelhos conectados</h2>
        <p class="muted">Esqueceu o EducaApoio aberto em outro computador ou perdeu o celular? Encerre o acesso em todos os aparelhos. Para voltar, basta pedir um novo código.</p>
        <button class="btn perigo" type="button" id="b-global">Sair de todos os aparelhos</button>
      </section>`;
    $('#b-som').addEventListener('click', () => {
      const ligar = !somLigado();
      definirSom(ligar);
      const b = $('#b-som');
      b.textContent = ligar ? 'Som ligado' : 'Som desligado';
      b.classList.toggle('sec', !ligar);
      if (ligar) tocarSom(true);
      toast(ligar ? 'Som dos avisos ligado.' : 'Som dos avisos desligado.');
    });
    $('#b-testar-som').addEventListener('click', () => tocarSom(true));
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
