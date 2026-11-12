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
    ['excluir', 'Excluir ocorrências', 'Apaga a ocorrência com conversa, linha do tempo e fotos. Pede motivo e fica registrado na Auditoria. Vale só para as ocorrências que a função enxerga.'],
    ['painel', 'Ver o painel de indicadores', 'Os números consideram só o que a função pode ver.'],
    ['relatorios', 'Gerar PDFs e relatórios', ''],
    ['turmas', 'Cadastrar, editar e excluir turmas', 'Só as turmas cadastradas aparecem para escolher ao registrar uma ocorrência.'],
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
  function toast(texto, aoClicar, alerta) {
    const t = $('#toast');
    t.textContent = texto;
    t.classList.toggle('toast-alerta', !!alerta);
    t.setAttribute('role', alerta ? 'alert' : 'status');
    t.classList.remove('oculto');
    t.onclick = () => { t.classList.add('oculto'); if (aoClicar) aoClicar(); };
    clearTimeout(toastTimer);
    // Alerta especial fica na tela até alguém clicar
    if (!alerta) toastTimer = setTimeout(() => t.classList.add('oculto'), 6000);
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

  // Prepara o arquivo uma vez (reduz a foto) para poder anexar em uma ou várias ocorrências
  async function prepararArquivo(arquivo) {
    const pdf = arquivo.type === 'application/pdf' || /\.pdf$/i.test(arquivo.name);
    if (!pdf && !/^image\//.test(arquivo.type)) throw new Error(`"${arquivo.name}" não é foto nem PDF.`);
    let blob = arquivo;
    let nome = nomeSeguro(arquivo.name);
    if (!pdf) {
      blob = await comprimirImagem(arquivo);
      nome = nome.replace(/\.[^.]+$/, '') + '.jpg';
    }
    if (blob.size > MAX_ANEXO) throw new Error(`"${arquivo.name}" passa de 10 MB. Envie um arquivo menor.`);
    return { blob, nome, tipo: pdf ? 'application/pdf' : 'image/jpeg', ext: pdf ? 'pdf' : 'jpg', original: arquivo.name };
  }

  // Guarda o arquivo na pasta da ocorrência e depois o registro dele
  async function enviarPreparado(ocId, prep) {
    const caminho = `${ocId}/${crypto.randomUUID()}.${prep.ext}`;
    const up = await sb.storage.from('anexos').upload(caminho, prep.blob, { contentType: prep.tipo, upsert: false });
    if (up.error) throw new Error(erroPT(up.error));
    const ins = await sb.from('anexos').insert({ ocorrencia_id: ocId, caminho, nome: prep.nome, tipo: prep.tipo, tamanho: prep.blob.size });
    if (ins.error) {
      await sb.storage.from('anexos').remove([caminho]);
      throw new Error(erroPT(ins.error));
    }
  }

  async function enviarAnexo(ocId, arquivo) {
    await enviarPreparado(ocId, await prepararArquivo(arquivo));
  }

  // Anexa os arquivos a uma ocorrência (número) ou a várias (lista de números)
  async function enviarVarios(ocIds, arquivos, aoProgresso) {
    const ids = Array.isArray(ocIds) ? ocIds : [ocIds];
    const falhas = [];
    const total = arquivos.length * ids.length;
    let feito = 0;
    for (const arq of arquivos) {
      let prep;
      try { prep = await prepararArquivo(arq); } catch (e) { falhas.push(e.message); feito += ids.length; continue; }
      for (const id of ids) {
        feito += 1;
        if (aoProgresso) aoProgresso(feito, total);
        try { await enviarPreparado(id, prep); } catch (e) { falhas.push(`${prep.original}: ${e.message}`); }
      }
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
    const ba = await sb.rpc('pode_busca_ativa');
    eu.buscaAtiva = !ba.error && ba.data === true;
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
      ['#/turmas', 'Turmas', pode('turmas')],
      ['#/busca-ativa', 'Busca ativa', eu.buscaAtiva],
      ['#/usuarios', 'Usuários', ehDirecao()],
      ['#/funcoes', 'Funções de acesso', ehDirecao()],
      ['#/configuracoes', 'Configurações', pode('configuracoes')],
      ['#/auditoria', 'Auditoria', pode('auditoria')],
      ['#/conta', 'Minha conta', true],
    ];
    $('#menu').innerHTML = itens.filter((i) => i[2]).map(([h, t]) => `<a href="${h}">${esc(t)}</a>`).join('');
    $('#nome-usuario').textContent = eu.nome;
    if (!$('#link-alterar-nome')) {
      $('#perfil-usuario').insertAdjacentHTML('afterend', '<a id="link-alterar-nome" class="link-lateral" href="#/conta?editar=nome">alterar nome</a>');
    }
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
      ? itens.map((i) => `<a href="#/ocorrencia/${i.ocorrencia_id}" class="${i.lida ? '' : 'nao-lida'}${i.tipo === 'alerta' ? ' alerta' : ''}">${esc(i.texto)}<br><span class="muted">${dataHora(i.criado_em)}</span></a>`).join('')
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
        if (n.tipo === 'alerta') {
          toast(n.texto + ' (clique para ver)', () => { location.hash = '#/ocorrencia/' + n.ocorrencia_id; }, true);
          tocarSom();
          setTimeout(() => tocarSom(), 900);
        } else if (!(ocAtual === n.ocorrencia_id && /comentou/.test(n.texto))) {
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
        case 'limpeza-anual': return await telaLimpeza();
        case 'turmas': return await telaTurmas();
        case 'busca-ativa': return params.caso ? await telaCasoBusca(Number(params.caso)) : await telaBuscaAtiva(params);
        case 'auditoria': return await telaAuditoria(params);
        case 'conta': return await telaConta(params);
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
    const titulo = p.aluno ? `Histórico de ${p.aluno}${p.turma ? ` (${p.turma})` : ''}` : pode('ver_todas') ? 'Ocorrências' : 'Minhas ocorrências';

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
        <thead><tr><th>Data</th><th>Estudante</th><th>Turma</th><th>Tipo</th><th>Registrado por</th><th>Situação</th></tr></thead>
        <tbody>${r.data.map((o) => `
          <tr class="clicavel" data-id="${o.id}" tabindex="0">
            <td>${dataBR(o.data_fato)}</td><td>${esc(o.aluno)}${o.grupo ? '<br><span class="tag-grupo">Em grupo</span>' : ''}</td><td>${esc(o.turma)}</td>
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
  /* ================= Turmas (lista para escolher) ================= */
  const ordemNatural = (a, b) => a.localeCompare(b, 'pt-BR', { numeric: true, sensitivity: 'base' });
  async function turmasAtivas() {
    const r = await sb.from('turmas').select('nome').eq('ativo', true);
    if (r.error) throw new Error(/turmas/i.test(r.error.message) ? 'O cadastro de turmas ainda não foi ativado. Rode o arquivo migracao-turmas.sql no Supabase.' : erroPT(r.error));
    return r.data.map((t) => t.nome).sort(ordemNatural);
  }
  function opcoesTurma(lista, atual) {
    const nomes = atual && !lista.includes(atual) ? [atual, ...lista] : lista;
    return '<option value="">Escolha a turma</option>' +
      nomes.map((n) => `<option value="${esc(n)}" ${n === atual ? 'selected' : ''}>${esc(n)}${lista.includes(n) ? '' : ' (desativada)'}</option>`).join('');
  }

  /* ================= Alerta de faltas seguidas ================= */
  async function alertasFaltas() {
    const r = await sb.rpc('alertas_faltas');
    return r.error ? null : r.data; // null = migração ainda não rodada
  }
  function htmlAlertasFaltas(lista, compacto) {
    if (!lista || !lista.length) return '';
    const limite = escola.limite_faltas || 3;
    const linhas = (compacto ? lista.slice(0, 6) : lista).map((a) => `
      <li><a href="#/ocorrencias?${qs({ aluno: a.aluno, turma: a.turma })}"><strong>${esc(a.aluno)}</strong> (${esc(a.turma)})</a>:
        <strong>${a.qtd} faltas seguidas</strong>, de ${dataBR(a.inicio)} a ${dataBR(a.fim)}</li>`).join('');
    return `
      <section class="alerta-faltas" role="alert">
        <h2>Alerta de faltas: ${lista.length} estudante(s) com mais de ${limite} faltas seguidas</h2>
        <ul>${linhas}</ul>
        ${compacto && lista.length > 6 ? `<p><a href="#/painel">Ver todos no Painel</a></p>` : ''}
        <p class="muted">Considera dias úteis seguidos (segunda a sexta) e a última falta nos últimos 30 dias. Clique no nome para ver o histórico.</p>
      </section>`;
  }

  /* ================= Início ================= */
  async function telaInicio() {
    const contar = (status) => {
      let q = sb.from('v_ocorrencias').select('id', { count: 'exact', head: true }).eq('status', status);
      if (!pode('ver_todas')) q = q.eq('autor_id', eu.id);
      return q.then((r) => r.count || 0);
    };
    const [abertas, acomp, faltas] = await Promise.all([contar('ABERTA'), contar('EM_ACOMPANHAMENTO'), alertasFaltas()]);
    const primeiroNome = String(eu.nome || '').split(' ')[0];
    const hora = new Date().getHours();
    const saudacao = hora < 12 ? 'Bom dia' : hora < 18 ? 'Boa tarde' : 'Boa noite';
    const atalho = (href, titulo, texto, destaque) =>
      `<a class="atalho${destaque ? ' destaque' : ''}" href="${href}"><strong>${esc(titulo)}</strong><span>${esc(texto)}</span></a>`;
    conteudo.innerHTML = `
      <div class="cabecalho-pagina"><div><h1>${saudacao}, ${esc(primeiroNome)}!</h1>
        <p class="muted">O que você quer fazer agora?</p></div></div>
      ${htmlAlertasFaltas(faltas, true)}
      <div class="atalhos">
        ${pode('registrar') ? atalho('#/nova', 'Registrar ocorrência', 'Anotar um fato novo, com fotos se precisar.', true) : ''}
        ${atalho('#/ocorrencias', pode('ver_todas') ? 'Ver ocorrências' : 'Minhas ocorrências', 'Procurar pelo nome do estudante ou pela turma.')}
        ${pode('painel') ? atalho('#/painel', 'Painel', 'Números por mês, turma e tipo.') : ''}
        ${pode('relatorios') ? atalho('#/relatorios', 'Relatórios', 'Gerar PDF para imprimir ou enviar.') : ''}
        ${eu.buscaAtiva ? atalho('#/busca-ativa', 'Busca ativa', 'Acompanhar estudantes faltosos e registrar contatos com a família.') : ''}
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
    const turmas = await turmasAtivas();
    const cats = CATEGORIA_VISIVEL(true);
    conteudo.innerHTML = `
      <a class="voltar" href="#/inicio">&larr; Voltar</a>
      <div class="cabecalho-pagina"><div><h1>Registrar ocorrência</h1>
      <p class="muted">Preencha as 4 partes. Os campos com <span class="obrig-ex">*</span> são obrigatórios.</p></div></div>
      ${await sugestoes()}
      <form id="f-nova">
        <fieldset class="etapa">
          <legend><span class="num">1</span> Quem e quando</legend>
          <div style="max-width:260px"><label class="obrig" for="n-data">Data do fato</label><input id="n-data" type="date" name="data_fato" max="${hoje()}" value="${hoje()}" required></div>
          ${turmas.length ? '' : `<p class="erro">Nenhuma turma cadastrada. ${pode('turmas') ? 'Cadastre as turmas em <a href="#/turmas">Turmas</a>.' : 'Peça para a Direção cadastrar as turmas.'}</p>`}
          <div id="envolvidos" class="envolvidos"></div>
          <button class="btn sec" type="button" id="b-mais-aluno" ${turmas.length ? '' : 'disabled'}>+ Adicionar outro estudante</button>
          <p class="muted" id="aviso-grupo" style="margin-top:.6rem">Briga ou fato com estudantes de turmas diferentes? Adicione todos aqui: cada um ganha a própria ocorrência, ligada às outras.</p>
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

    const datalistAlunos = $('#dl-alunos') ? 'dl-alunos' : '';
    const linhaEnvolvido = () => `
      <div class="envolvido">
        <div><label class="obrig">Turma</label><select required ${turmas.length ? '' : 'disabled'}>${opcoesTurma(turmas, '')}</select></div>
        <div><label class="obrig">Estudante</label><input list="${datalistAlunos}" maxlength="150" placeholder="Nome completo" required></div>
        <button class="btn perigo peq remover-envolvido" type="button" title="Remover este estudante">Remover</button>
      </div>`;
    const renumerar = () => {
      const linhas = $$('#envolvidos .envolvido');
      linhas.forEach((l, i) => {
        const [lt, la] = $$('label', l);
        const sel = $('select', l);
        const inp = $('input', l);
        sel.id = `n-turma-${i}`; inp.id = `n-aluno-${i}`;
        lt.setAttribute('for', sel.id); la.setAttribute('for', inp.id);
        la.textContent = linhas.length > 1 ? `Estudante ${i + 1}` : 'Estudante';
        $('.remover-envolvido', l).classList.toggle('oculto', linhas.length === 1);
      });
      $('#aviso-grupo').innerHTML = linhas.length > 1
        ? `<strong>${linhas.length} estudantes:</strong> serão criadas ${linhas.length} ocorrências ligadas, uma para cada um, com a mesma descrição, providências e fotos.`
        : 'Briga ou fato com estudantes de turmas diferentes? Adicione todos aqui: cada um ganha a própria ocorrência, ligada às outras.';
    };
    const adicionarEnvolvido = (focar) => {
      $('#envolvidos').insertAdjacentHTML('beforeend', linhaEnvolvido());
      renumerar();
      if (focar) $('#envolvidos .envolvido:last-child select').focus();
    };
    $('#envolvidos').addEventListener('click', (e) => {
      const b = e.target.closest('.remover-envolvido');
      if (!b) return;
      b.closest('.envolvido').remove();
      renumerar();
    });
    $('#b-mais-aluno').addEventListener('click', () => adicionarEnvolvido(true));
    adicionarEnvolvido(false);

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
    $('#n-tipo').addEventListener('change', () => {
      const t = tipos.find((x) => String(x.id) === $('#n-tipo').value);
      if (t && t.e_falta) {
        if (!$('#n-desc').value.trim()) $('#n-desc').value = 'Estudante ausente.';
        if (!$('#n-prov').value.trim()) $('#n-prov').value = 'Registro de ausência.';
      }
    });
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
        const envolvidos = $$('#envolvidos .envolvido').map((l) => ({
          turma: $('select', l).value, aluno: $('input', l).value.trim().replace(/\s+/g, ' '),
        }));
        if (envolvidos.some((x) => !x.turma || !x.aluno)) throw new Error('Preencha a turma e o nome de cada estudante, ou remova a linha vazia.');
        const repetido = envolvidos.find((x, i) => envolvidos.findIndex((y) => y.aluno.toLowerCase() === x.aluno.toLowerCase() && y.turma === x.turma) !== i);
        if (repetido) throw new Error(`${repetido.aluno} (${repetido.turma}) aparece duas vezes.`);
        const grupo = envolvidos.length > 1 ? crypto.randomUUID() : null;
        const criadas = ok(await sb.from('ocorrencias').insert(envolvidos.map((x) => ({
          data_fato: d.data_fato, turma: x.turma, aluno: x.aluno, tipo_id: Number(d.tipo_id),
          descricao: d.descricao, providencias: d.providencias, status: d.status, grupo,
        }))).select('id'));
        const ids = criadas.map((c) => c.id).sort((x, y) => x - y);
        if (arquivos.length) {
          const falhas = await enviarVarios(ids, arquivos, (i, n) => { botao.textContent = `Enviando anexos ${i} de ${n}…`; });
          if (falhas.length) alert('As ocorrências foram salvas, mas alguns anexos não foram enviados:\n\n' + falhas.join('\n') + '\n\nVocê pode anexá-los de novo na tela de cada ocorrência.');
        }
        toast(ids.length > 1 ? `${ids.length} ocorrências registradas, uma para cada estudante.` : 'Ocorrência registrada.');
        location.hash = '#/ocorrencia/' + ids[0];
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
        const editando = $('#f-editar') && !$('#f-editar').classList.contains('oculto');
        if (ocAtual === id && !editando) telaDetalhe(id, true);
      })
      .subscribe();
  }

  async function telaDetalhe(id, atualizacao) {
    const o = ok(await sb.from('v_ocorrencias').select('*').eq('id', id).maybeSingle());
    if (!o) throw new Error('Ocorrência não encontrada.');
    const comChat = pode('conversar');
    const encerrada = o.status === 'ENCERRADA';
    // Mesma regra do banco: Direção sempre; quem registrou ou quem acompanha, se não estiver encerrada
    const podeEditar = ehDirecao() || (!encerrada && (o.autor_id === eu.id || pode('acompanhar')));
    // Outras ocorrências do mesmo fato (grupo), que a pessoa pode ver
    const grupoOutros = o.grupo
      ? ok(await sb.from('v_ocorrencias').select('id, aluno, turma, status').eq('grupo', o.grupo).neq('id', id).order('id'))
      : [];
    const [historico, mensagens, totalAluno, anexos] = await Promise.all([
      sb.from('historico_status').select('*, usuario:perfis(nome)').eq('ocorrencia_id', id).order('id').then(ok),
      comChat ? sb.from('mensagens').select(SEL_MSG).eq('ocorrencia_id', id).order('id').then(ok) : Promise.resolve([]),
      sb.from('ocorrencias').select('id', { count: 'exact', head: true }).ilike('aluno', exato(o.aluno)).eq('turma', o.turma).then((r) => r.count),
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
        <div><h1>Ocorrência de ${esc(o.aluno)} <span class="h1-turma">(${esc(o.turma)})</span></h1><p class="muted">Registrada por ${esc(o.autor_nome)}${o.autor_funcao ? ` (${esc(o.autor_funcao)})` : ''} em ${dataHora(o.criado_em)}</p></div>
        <div>${carimbo(o.status, true)}</div>
      </div>
      <div class="detalhe${comChat ? '' : ' sem-chat'}">
        <section class="folha dados">
          <div id="ver-dados">
          <dl>
            <dt>Estudante</dt><dd>${esc(o.aluno)}</dd>
            <dt>Turma</dt><dd>${esc(o.turma)}</dd>
            <dt>Data do fato</dt><dd>${dataBR(o.data_fato)}</dd>
            <dt>Categoria</dt><dd>${esc(o.categoria_nome || nomeCategoria(o.categoria))}</dd>
            <dt>Tipo</dt><dd>${esc(o.tipo_nome)}</dd>
          </dl>
          ${o.grupo ? `
          <div class="grupo-box">
            <strong>Ocorrência em grupo.</strong> O mesmo fato foi registrado também para:
            ${grupoOutros.length ? `<ul>${grupoOutros.map((g) => `<li><a href="#/ocorrencia/${g.id}">${esc(g.aluno)} (${esc(g.turma)})</a> ${carimbo(g.status)}</li>`).join('')}</ul>`
              : '<p class="muted" style="margin:.3rem 0 0">outros estudantes que você não tem permissão para ver.</p>'}
            <p class="muted" style="margin:.4rem 0 0">Cada estudante tem a própria ocorrência: editar, encerrar ou excluir vale só para esta.</p>
          </div>` : ''}
          <h2>Descrição do fato</h2><div class="texto-livre">${esc(o.descricao)}</div>
          <h2>Providências adotadas</h2><div class="texto-livre">${esc(o.providencias)}</div>
          ${podeEditar ? '<button class="btn sec" type="button" id="b-editar">Editar ocorrência</button>' : ''}
          ${!podeEditar && encerrada && o.autor_id === eu.id ? '<p class="muted">Ocorrência encerrada: para corrigir algo, peça para reabrirem a ocorrência ou fale com a Direção.</p>' : ''}
          </div>
          <form id="f-editar" class="oculto edicao"></form>
          <div class="acoes">
            ${pode('relatorios') ? '<button class="btn sec" type="button" id="b-pdf">Gerar PDF para prontuário</button>' : ''}
            <a class="btn sec" href="#/ocorrencias?${qs({ aluno: o.aluno, turma: o.turma })}">Histórico do estudante (${totalAluno == null ? '?' : totalAluno})</a>
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
      ${pode('excluir') ? `
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

    if ($('#b-editar')) {
      $('#b-editar').addEventListener('click', async () => {
        const b = $('#b-editar');
        b.disabled = true;
        try {
          const todosTipos = ok(await sb.from('tipos_ocorrencia').select('*').order('nome'));
          // Tipos ativos, mais o tipo atual (mesmo se desativado depois)
          const tiposOk = todosTipos.filter((t) => t.ativo || t.id === o.tipo_id);
          const cats = categoriasVisiveis(true);
          if (!cats.includes(o.categoria)) cats.push(o.categoria);
          const turmas = await turmasAtivas();
          const f = $('#f-editar');
          f.innerHTML = `
            <h2 style="margin-top:0">Editar ocorrência de ${esc(o.aluno)}</h2>
            <p class="muted">Corrija o que for preciso. A correção fica registrada na linha do tempo, com o que mudou, quem corrigiu e quando.</p>
            <div class="grade-3">
              <div><label class="obrig" for="ed-data">Data do fato</label><input id="ed-data" type="date" name="data_fato" max="${hoje()}" value="${esc(o.data_fato)}" required></div>
              <div><label class="obrig" for="ed-turma">Turma</label><select id="ed-turma" name="turma" required>${opcoesTurma(turmas, o.turma)}</select></div>
              <div><label class="obrig" for="ed-aluno">Estudante</label><input id="ed-aluno" name="aluno" list="dl-alunos" maxlength="150" value="${esc(o.aluno)}" required></div>
            </div>
            <div class="grade-2">
              <div><label class="obrig" for="ed-cat">Categoria</label><select id="ed-cat" required>${cats.map((c) => `<option value="${esc(c)}" ${c === o.categoria ? 'selected' : ''}>${esc(nomeCategoria(c))}</option>`).join('')}</select></div>
              <div><label class="obrig" for="ed-tipo">Tipo de ocorrência</label><select id="ed-tipo" name="tipo_id" required></select></div>
            </div>
            <label class="obrig" for="ed-desc">Descrição do fato</label>
            <textarea id="ed-desc" name="descricao" maxlength="5000" required>${esc(o.descricao)}</textarea>
            <label class="obrig" for="ed-prov">Providências adotadas</label>
            <textarea id="ed-prov" name="providencias" maxlength="3000" required>${esc(o.providencias)}</textarea>
            <label for="ed-motivo">O que foi corrigido? (opcional)</label>
            <input id="ed-motivo" name="motivo" maxlength="300" placeholder="Ex.: a série estava errada">
            <p class="erro" id="ed-erro" role="alert"></p>
            <div class="acoes"><button class="btn" type="submit">Salvar alterações</button><button class="btn sec" type="button" id="ed-cancelar">Cancelar</button></div>
            ${await sugestoes()}`;
          const preencher = () => {
            const cat = $('#ed-cat').value;
            const lista = tiposOk.filter((t) => t.categoria === cat);
            $('#ed-tipo').innerHTML = lista.length
              ? lista.map((t) => `<option value="${t.id}" ${t.id === o.tipo_id ? 'selected' : ''}>${esc(t.nome)}${t.ativo ? '' : ' (desativado)'}</option>`).join('')
              : '<option value="">Nenhum tipo nesta categoria</option>';
            if (cat !== o.categoria && lista.length) $('#ed-tipo').insertAdjacentHTML('afterbegin', '<option value="" selected>Escolha o tipo</option>');
          };
          $('#ed-cat').addEventListener('change', preencher);
          preencher();
          $('#ver-dados').classList.add('oculto');
          f.classList.remove('oculto');
          $('#ed-turma').focus();
          $('#ed-cancelar').addEventListener('click', () => {
            f.classList.add('oculto');
            f.innerHTML = '';
            $('#ver-dados').classList.remove('oculto');
            b.disabled = false;
          });
          f.onsubmit = async (e) => {
            e.preventDefault();
            const d = lerForm(f);
            const bs = $('button[type=submit]', f);
            bs.disabled = true;
            bs.textContent = 'Salvando…';
            try {
              ok(await sb.rpc('editar_ocorrencia', {
                p_id: id, p_data_fato: d.data_fato, p_turma: d.turma, p_aluno: d.aluno, p_tipo_id: Number(d.tipo_id),
                p_descricao: d.descricao, p_providencias: d.providencias, p_motivo: d.motivo || null,
              }));
              toast('Ocorrência corrigida.');
              telaDetalhe(id, true);
            } catch (err) {
              $('#ed-erro').textContent = erroPT(err);
              bs.disabled = false;
              bs.textContent = 'Salvar alterações';
            }
          };
        } catch (err) {
          toast(erroPT(err));
          b.disabled = false;
        }
      });
    }

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
        if (!confirm(`Última confirmação: excluir a ocorrência de ${o.aluno} (${o.turma}), do dia ${dataBR(o.data_fato)}?`)) return;
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
          toast(`Ocorrência de ${o.aluno} excluída.`);
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
          window.EducaApoioPDF.ficha({ ...o, grupo_qtd: grupoOutros.length }, historico, escola, eu.nome, lista);
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
      ${htmlAlertasFaltas(await alertasFaltas(), false)}
      <h2>Estudantes com mais ocorrências</h2>
      <p class="muted">Em destaque, quem tem ${d.limite_atencao} ou mais registros no período: avalie acompanhamento especial.</p>
      ${d.alunos.length ? `<div class="tabela-wrap"><table>
        <thead><tr><th>Estudante</th><th>Turma</th><th class="num">Total</th><th class="num">Não encerradas</th><th class="num">Conviva</th><th>Última</th></tr></thead>
        <tbody>${d.alunos.map((a) => `
          <tr class="clicavel" data-aluno="${esc(a.aluno)}" data-turma="${esc(a.turma)}" tabindex="0">
            <td class="${a.n >= d.limite_atencao ? 'atencao' : ''}">${esc(a.aluno)}${a.n >= d.limite_atencao ? ' (atenção)' : ''}</td>
            <td>${esc(a.turma)}</td><td class="num">${a.n}</td><td class="num">${a.em_aberto}</td><td class="num">${a.conviva}</td><td>${dataBR(a.ultima)}</td>
          </tr>`).join('')}</tbody></table></div>` : '<p class="muted">Sem dados no período.</p>'}`;

    $('#f-painel').addEventListener('submit', (e) => { e.preventDefault(); location.hash = '#/painel?' + qs(lerForm(e.target)); });
    $$('tr[data-aluno]').forEach((tr) => {
      const ir = () => { location.hash = '#/ocorrencias?' + qs({ aluno: tr.dataset.aluno, turma: tr.dataset.turma }); };
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
    const [lista, funcoes, autorizados] = await Promise.all([
      sb.rpc('listar_usuarios').then(ok),
      sb.from('busca_ativa_autorizados').select('usuario_id').then((r) => (r.error ? null : r.data.map((a) => a.usuario_id))),
      sb.from('funcoes').select('id, nome, direcao').order('direcao', { ascending: false }).order('nome').then(ok),
    ]);
    const opcoesFuncao = (sel, vazio) =>
      (vazio ? `<option value="">${esc(vazio)}</option>` : '') +
      funcoes.map((f) => `<option value="${f.id}" ${f.id === sel ? 'selected' : ''}>${esc(f.nome)}</option>`).join('');
    const pendentes = lista.filter((u) => !u.funcao_id).length;
    const idsDirecao = new Set(funcoes.filter((f) => f.direcao).map((f) => f.id));
    const celulaBusca = (u) => {
      if (idsDirecao.has(u.funcao_id)) return '<span class="muted">Sempre (Direção)</span>';
      if (autorizados === null) return '<span class="muted">-</span>';
      const tem = autorizados.includes(u.id);
      return `<button class="btn ${tem ? '' : 'sec'} peq" type="button" data-busca="${tem ? 0 : 1}">${tem ? 'Permitida' : 'Permitir'}</button>`;
    };

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
        <thead><tr><th>Nome</th><th>E-mail</th><th>Função</th><th>Busca ativa</th><th>Situação</th><th>Ações</th></tr></thead>
        <tbody>${lista.map((u) => `
          <tr data-id="${u.id}" data-nome="${esc(u.nome)}">
            <td>${esc(u.nome)}</td>
            <td>${esc(u.email)}</td>
            <td><select class="u-funcao" aria-label="Função de ${esc(u.nome)}" ${u.id === eu.id ? 'disabled' : ''}>${opcoesFuncao(u.funcao_id, u.funcao_id ? null : 'Aguardando liberação')}</select></td>
            <td>${celulaBusca(u)}</td>
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
      const bb = $('button[data-busca]', tr);
      if (bb) bb.addEventListener('click', async () => {
        const liberar = bb.dataset.busca === '1';
        if (!confirm(liberar
          ? `Permitir que ${nome} faça a busca ativa? A pessoa verá os estudantes com faltas de todas as turmas.`
          : `Tirar o acesso de ${nome} à busca ativa?`)) return;
        try {
          if (liberar) ok(await sb.from('busca_ativa_autorizados').insert({ usuario_id: id }));
          else ok(await sb.from('busca_ativa_autorizados').delete().eq('usuario_id', id));
          toast(liberar ? `${nome} agora pode fazer a busca ativa (vale ao atualizar a página).` : `${nome} não tem mais acesso à busca ativa.`);
          telaUsuarios();
        } catch (err) { toast(erroPT(err)); }
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
        <p class="muted" style="margin-top:.6rem">Cadastrar pessoas, criar funções e fazer a limpeza anual são sempre exclusivos da Direção.</p>
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
          <div><label for="c-faltas">Alertar quando o estudante passar de quantas faltas seguidas</label><input id="c-faltas" name="limite_faltas" type="number" min="1" max="30" value="${escola.limite_faltas || 3}"></div>
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
              <li><span>${esc(t.nome)}${t.e_falta ? ' <span class="tag-falta">conta como falta</span>' : ''}${t.ativo ? '' : ' <span class="muted">(desativado)</span>'}</span>
                  <span class="acoes-tabela">
                    ${'e_falta' in t ? `<button class="btn sec peq" type="button" data-falta="${t.id}" data-valor="${t.e_falta ? 0 : 1}">${t.e_falta ? 'Não contar como falta' : 'Contar como falta'}</button>` : ''}
                    <button class="btn sec peq" type="button" data-id="${t.id}" data-ativo="${t.ativo ? 0 : 1}">${t.ativo ? 'Desativar' : 'Reativar'}</button>
                  </span></li>`).join('') || '<li class="muted">Nenhum tipo ainda.</li>'}
          </ul>
          <form class="f-tipo-cat" data-cat="${esc(c.id)}">
            <input name="nome" maxlength="80" required placeholder="Novo tipo nesta categoria" aria-label="Novo tipo em ${esc(c.nome)}">
            <button class="btn peq" type="submit">Adicionar tipo</button>
          </form>
        </section>`).join('')}
      ${ehDirecao() ? `
      <details class="area-restrita">
        <summary>Área restrita da Direção</summary>
        <p class="muted">Ferramentas que apagam dados de forma definitiva. Use só quando for necessário.</p>
        <a class="btn perigo" href="#/limpeza-anual">Limpeza anual de ocorrências</a>
      </details>` : ''}`;

    $('#f-escola').addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = lerForm(e.target);
      try {
        ok(await sb.from('configuracoes').update({
          escola_nome: d.escola_nome.trim(), escola_endereco: d.escola_endereco.trim(),
          limite_atencao: Number(d.limite_atencao) || 3,
          ...('limite_faltas' in escola ? { limite_faltas: Math.min(30, Math.max(1, Number(d.limite_faltas) || 3)) } : {}),
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
    $$('button[data-falta]').forEach((b) => b.addEventListener('click', async () => {
      try {
        ok(await sb.from('tipos_ocorrencia').update({ e_falta: b.dataset.valor === '1' }).eq('id', b.dataset.falta));
        toast(b.dataset.valor === '1' ? 'Este tipo agora conta para o alerta de faltas.' : 'Este tipo não conta mais como falta.');
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

  /* ================= Turmas (cadastro) ================= */
  async function telaTurmas() {
    if (!pode('turmas')) throw new Error('Sua função não tem acesso ao cadastro de turmas.');
    const lista = ok(await sb.from('turmas').select('*'));
    lista.sort((a, b) => (b.ativo - a.ativo) || ordemNatural(a.nome, b.nome));
    // Quantas ocorrências cada turma tem (para saber se pode excluir)
    const contagem = {};
    await Promise.all(lista.map(async (t) => {
      const r = await sb.from('ocorrencias').select('id', { count: 'exact', head: true }).eq('turma', t.nome);
      contagem[t.id] = r.count || 0;
    }));
    const ativas = lista.filter((t) => t.ativo).length;

    conteudo.innerHTML = `
      <div class="cabecalho-pagina"><div><h1>Turmas</h1>
        <p class="muted">Só as turmas desta lista aparecem para escolher ao registrar uma ocorrência. ${ativas} turma(s) ativa(s).</p></div></div>

      <form class="folha" id="f-turma">
        <h3>Cadastrar turmas</h3>
        <p class="muted">Escreva uma turma por linha. Dá para colar a lista inteira de uma vez, por exemplo no começo do ano.</p>
        <label for="tu-nomes">Turmas</label>
        <textarea id="tu-nomes" rows="5" placeholder="6º A&#10;6º B&#10;7º A&#10;1ª série EM A"></textarea>
        <p class="erro" id="tu-erro" role="alert"></p>
        <button class="btn" type="submit">Cadastrar</button>
      </form>

      <h2>Turmas cadastradas</h2>
      ${lista.length ? `<div class="tabela-wrap"><table>
        <thead><tr><th>Turma</th><th class="num">Ocorrências</th><th>Situação</th><th>Ações</th></tr></thead>
        <tbody>${lista.map((t) => `
          <tr>
            <td><strong>${esc(t.nome)}</strong></td>
            <td class="num">${contagem[t.id]}</td>
            <td>${t.ativo ? 'Ativa' : '<span class="muted">Desativada</span>'}</td>
            <td class="acoes-tabela">
              <button class="btn sec peq" type="button" data-renomear-turma="${t.id}" data-nome="${esc(t.nome)}">Renomear</button>
              <button class="btn sec peq" type="button" data-ativar-turma="${t.id}" data-valor="${t.ativo ? 0 : 1}" data-nome="${esc(t.nome)}">${t.ativo ? 'Desativar' : 'Reativar'}</button>
              ${contagem[t.id] ? '' : `<button class="btn perigo peq" type="button" data-excluir-turma="${t.id}" data-nome="${esc(t.nome)}">Excluir</button>`}
            </td>
          </tr>`).join('')}</tbody></table></div>
        <p class="muted" style="margin-top:.7rem">Turmas com ocorrências não podem ser excluídas, para não perder o histórico: desative quando a turma deixar de existir. Ao renomear, o nome muda também nas ocorrências antigas.</p>`
        : '<p class="muted">Nenhuma turma cadastrada ainda.</p>'}`;

    $('#f-turma').addEventListener('submit', async (e) => {
      e.preventDefault();
      const nomes = [...new Set($('#tu-nomes').value.split(/\r?\n/).map((n) => n.trim().replace(/\s+/g, ' ')).filter(Boolean))];
      if (!nomes.length) { $('#tu-erro').textContent = 'Escreva pelo menos uma turma.'; return; }
      const longas = nomes.filter((n) => n.length > 40);
      if (longas.length) { $('#tu-erro').textContent = `Nome muito longo (máximo 40 letras): ${longas[0]}`; return; }
      const existentes = new Set(lista.map((t) => t.nome.toLowerCase()));
      const novas = nomes.filter((n) => !existentes.has(n.toLowerCase()));
      const repetidas = nomes.length - novas.length;
      try {
        if (novas.length) ok(await sb.from('turmas').insert(novas.map((nome) => ({ nome }))));
        toast(`${novas.length} turma(s) cadastrada(s).${repetidas ? ` ${repetidas} já existia(m).` : ''}`);
        telaTurmas();
      } catch (err) {
        $('#tu-erro').textContent = /duplicate|unique/i.test(err.message) ? 'Alguma dessas turmas já está cadastrada.' : erroPT(err);
      }
    });
    $$('button[data-renomear-turma]').forEach((b) => b.addEventListener('click', async () => {
      const novo = prompt(`Novo nome para a turma ${b.dataset.nome}:`, b.dataset.nome);
      if (!novo || !novo.trim() || novo.trim() === b.dataset.nome) return;
      if (!confirm(`Renomear "${b.dataset.nome}" para "${novo.trim()}"? O nome muda também em todas as ocorrências desta turma.`)) return;
      try {
        ok(await sb.from('turmas').update({ nome: novo.trim() }).eq('id', b.dataset.renomearTurma));
        toast('Turma renomeada.');
        telaTurmas();
      } catch (err) { toast(/duplicate|unique/i.test(err.message) ? 'Já existe uma turma com esse nome.' : erroPT(err)); }
    }));
    $$('button[data-ativar-turma]').forEach((b) => b.addEventListener('click', async () => {
      const ativar = b.dataset.valor === '1';
      if (!ativar && !confirm(`Desativar a turma ${b.dataset.nome}? Ela some da lista ao registrar ocorrências, mas o histórico continua.`)) return;
      try {
        ok(await sb.from('turmas').update({ ativo: ativar }).eq('id', b.dataset.ativarTurma));
        telaTurmas();
      } catch (err) { toast(erroPT(err)); }
    }));
    $$('button[data-excluir-turma]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm(`Excluir a turma ${b.dataset.nome}?`)) return;
      try {
        ok(await sb.from('turmas').delete().eq('id', b.dataset.excluirTurma));
        toast('Turma excluída.');
        telaTurmas();
      } catch (err) { toast(erroPT(err)); }
    }));
  }

  /* ================= Busca ativa (pessoas liberadas pela Direção) ================= */
  const SITUACAO_BUSCA = {
    EM_BUSCA: 'Em busca', CONTATO_FEITO: 'Contato feito', RETORNOU: 'Retornou às aulas',
    ENCAMINHADO: 'Encaminhado (Conselho Tutelar / rede)', ENCERRADO: 'Encerrado',
  };
  const FORMA_CONTATO = { TELEFONE: 'Telefone', WHATSAPP: 'WhatsApp', VISITA: 'Visita à casa', BILHETE: 'Bilhete / recado', EMAIL: 'E-mail', OUTRO: 'Outro' };
  const RESULTADO_CONTATO = {
    SEM_SUCESSO: 'Não consegui falar', CONVERSOU: 'Conversei com a família',
    RETORNO_COMBINADO: 'Família combinou o retorno', OUTRO: 'Outro',
  };
  const etiquetaBusca = (s) => `<span class="etiqueta-busca ${s}">${esc(SITUACAO_BUSCA[s] || s)}</span>`;

  async function abrirCasoBusca(aluno, turma, motivo) {
    const r = await sb.from('busca_ativa_casos').insert({ aluno, turma, motivo }).select('id').single();
    if (r.error) {
      if (/duplicate|unique/i.test(r.error.message)) throw new Error('Este estudante já tem um caso de busca ativa aberto.');
      throw new Error(erroPT(r.error));
    }
    return r.data.id;
  }

  async function telaBuscaAtiva(p) {
    if (!eu.buscaAtiva) throw new Error('Seu e-mail não tem permissão para a busca ativa. Fale com a Direção.');
    const verTodos = p.ver === 'todos';
    let qCasos = sb.from('busca_ativa_casos').select('*').order('atualizado_em', { ascending: false });
    if (!verTodos) qCasos = qCasos.in('situacao', ['EM_BUSCA', 'CONTATO_FEITO', 'ENCAMINHADO']);
    const [alertas, casos, turmas] = await Promise.all([
      sb.rpc('alertas_faltas_busca').then(ok),
      qCasos.then(ok),
      turmasAtivas().catch(() => []),
    ]);
    const contatos = casos.length
      ? ok(await sb.from('busca_ativa_contatos').select('caso_id, data_contato').in('caso_id', casos.map((c) => c.id)))
      : [];
    const resumo = {};
    contatos.forEach((c) => {
      const x = (resumo[c.caso_id] = resumo[c.caso_id] || { n: 0, ultimo: null });
      x.n += 1;
      if (!x.ultimo || c.data_contato > x.ultimo) x.ultimo = c.data_contato;
    });
    const semCaso = alertas.filter((a) => !a.caso_id);

    conteudo.innerHTML = `
      <div class="cabecalho-pagina"><div><h1>Busca ativa</h1>
        <p class="muted">Acompanhe os estudantes que estão faltando e registre cada contato com a família, até o retorno às aulas.</p></div></div>

      <section class="folha">
        <h2 style="margin-top:0">Estudantes em alerta de faltas</h2>
        ${alertas.length ? `<div class="tabela-wrap"><table>
          <thead><tr><th>Estudante</th><th>Turma</th><th class="num">Faltas seguidas</th><th>Período</th><th></th></tr></thead>
          <tbody>${alertas.map((a, i) => `
            <tr>
              <td><strong>${esc(a.aluno)}</strong></td><td>${esc(a.turma)}</td>
              <td class="num"><strong class="atencao">${a.qtd}</strong></td>
              <td>${dataBR(a.inicio)} a ${dataBR(a.fim)}</td>
              <td>${a.caso_id
                ? `<a class="btn sec peq" href="#/busca-ativa?caso=${a.caso_id}">Ver caso</a>`
                : `<button class="btn peq" type="button" data-iniciar="${i}">Iniciar busca ativa</button>`}</td>
            </tr>`).join('')}</tbody></table></div>
          ${semCaso.length ? `<p class="muted" style="margin-top:.6rem">${semCaso.length} estudante(s) em alerta ainda sem busca ativa iniciada.</p>` : ''}`
          : '<p class="muted">Nenhum estudante em alerta de faltas seguidas no momento.</p>'}
      </section>

      <div class="cabecalho-pagina" style="margin-top:1.6rem"><div><h2 style="margin:0">${verTodos ? 'Todos os casos' : 'Casos em andamento'}</h2></div>
        <a class="btn sec peq" href="#/busca-ativa${verTodos ? '' : '?ver=todos'}">${verTodos ? 'Ver só os em andamento' : 'Ver também os encerrados'}</a>
      </div>
      ${casos.length ? `<div class="tabela-wrap"><table>
        <thead><tr><th>Estudante</th><th>Turma</th><th>Situação</th><th class="num">Contatos</th><th>Último contato</th><th>Aberto em</th></tr></thead>
        <tbody>${casos.map((c) => `
          <tr class="clicavel" data-caso="${c.id}" tabindex="0">
            <td><strong>${esc(c.aluno)}</strong></td><td>${esc(c.turma)}</td><td>${etiquetaBusca(c.situacao)}</td>
            <td class="num">${resumo[c.id] ? resumo[c.id].n : 0}</td>
            <td>${resumo[c.id] ? dataBR(resumo[c.id].ultimo) : '<span class="atencao">Nenhum ainda</span>'}</td>
            <td>${dataHora(c.criado_em)}</td>
          </tr>`).join('')}</tbody></table></div>`
        : `<p class="muted">${verTodos ? 'Nenhum caso registrado.' : 'Nenhum caso em andamento.'}</p>`}

      <details class="area-restrita" style="margin-top:1.6rem">
        <summary>Abrir busca ativa para outro estudante</summary>
        <form id="f-caso-manual">
          <div class="grade-2">
            <div><label class="obrig" for="ba-turma">Turma</label><select id="ba-turma" required>${opcoesTurma(turmas, '')}</select></div>
            <div><label class="obrig" for="ba-aluno">Estudante</label><input id="ba-aluno" maxlength="150" required placeholder="Nome completo"></div>
          </div>
          <label for="ba-motivo">Motivo</label>
          <input id="ba-motivo" maxlength="500" placeholder="Ex.: faltas alternadas, família pediu ajuda">
          <p class="erro" id="ba-erro" role="alert"></p>
          <button class="btn" type="submit">Abrir caso</button>
        </form>
      </details>`;

    $$('button[data-iniciar]').forEach((b) => b.addEventListener('click', async () => {
      const a = alertas[Number(b.dataset.iniciar)];
      b.disabled = true;
      try {
        const id = await abrirCasoBusca(a.aluno, a.turma, `${a.qtd} faltas seguidas, de ${dataBR(a.inicio)} a ${dataBR(a.fim)}.`);
        toast('Busca ativa iniciada.');
        location.hash = '#/busca-ativa?caso=' + id;
      } catch (err) { toast(err.message); b.disabled = false; }
    }));
    $$('tr[data-caso]').forEach((tr) => {
      const ir = () => { location.hash = '#/busca-ativa?caso=' + tr.dataset.caso; };
      tr.addEventListener('click', ir);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') ir(); });
    });
    $('#f-caso-manual').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const id = await abrirCasoBusca($('#ba-aluno').value.trim(), $('#ba-turma').value, $('#ba-motivo').value.trim());
        toast('Busca ativa iniciada.');
        location.hash = '#/busca-ativa?caso=' + id;
      } catch (err) { $('#ba-erro').textContent = err.message; }
    });
  }

  async function telaCasoBusca(id) {
    if (!eu.buscaAtiva) throw new Error('Seu e-mail não tem permissão para a busca ativa. Fale com a Direção.');
    const caso = ok(await sb.from('busca_ativa_casos').select('*, aberto:perfis!busca_ativa_casos_aberto_por_fkey(nome)').eq('id', id).maybeSingle());
    if (!caso) throw new Error('Caso não encontrado.');
    const contatos = ok(await sb.from('busca_ativa_contatos').select('*, usuario:perfis(nome)').eq('caso_id', id).order('data_contato', { ascending: false }).order('id', { ascending: false }));
    const aberto = !['RETORNOU', 'ENCERRADO'].includes(caso.situacao);

    conteudo.innerHTML = `
      <a class="voltar" href="#/busca-ativa">&larr; Voltar para a Busca ativa</a>
      <div class="cabecalho-pagina">
        <div><h1>Busca ativa: ${esc(caso.aluno)} <span class="h1-turma">(${esc(caso.turma)})</span></h1>
          <p class="muted">Aberta por ${esc(caso.aberto ? caso.aberto.nome : '')} em ${dataHora(caso.criado_em)}${caso.motivo ? `. Motivo: ${esc(caso.motivo)}` : ''}</p></div>
        <div>${etiquetaBusca(caso.situacao)}</div>
      </div>
      <div class="detalhe">
        <section class="folha">
          <h2 style="margin-top:0">Registrar contato</h2>
          ${aberto ? '' : '<p class="muted">Este caso está finalizado. Para registrar novos contatos, mude a situação abaixo.</p>'}
          <form id="f-contato" ${aberto ? '' : 'class="oculto"'}>
            <div class="grade-2">
              <div><label class="obrig" for="ct-data">Data do contato</label><input id="ct-data" type="date" max="${hoje()}" value="${hoje()}" required></div>
              <div><label class="obrig" for="ct-forma">Como foi o contato</label><select id="ct-forma" required>${opcoes(FORMA_CONTATO, 'TELEFONE')}</select></div>
            </div>
            <label for="ct-resp">Com quem falou (ou tentou falar)</label>
            <input id="ct-resp" maxlength="150" placeholder="Ex.: mãe, Maria">
            <label class="obrig" for="ct-res">Resultado</label>
            <select id="ct-res" required>${opcoes(RESULTADO_CONTATO, 'SEM_SUCESSO')}</select>
            <label for="ct-obs">O que foi conversado ou combinado</label>
            <textarea id="ct-obs" maxlength="2000" placeholder="Ex.: a mãe disse que o aluno está doente e volta na segunda."></textarea>
            <p class="erro" id="ct-erro" role="alert"></p>
            <button class="btn" type="submit">Salvar contato</button>
          </form>

          <h2>Situação do caso</h2>
          <div class="f-tipo-cat">
            <select id="cs-situacao">${opcoes(SITUACAO_BUSCA, caso.situacao)}</select>
            <button class="btn sec" type="button" id="cs-salvar">Salvar situação</button>
          </div>
          <p class="muted" style="margin-top:.5rem">Quando o estudante voltar às aulas, marque "Retornou às aulas". Ao conseguir falar com a família, o caso passa sozinho para "Contato feito".</p>
          <p style="margin-top:1rem"><a href="#/ocorrencias?${qs({ aluno: caso.aluno, turma: caso.turma })}">Ver as ocorrências deste estudante</a></p>
        </section>

        <section class="folha">
          <h2 style="margin-top:0">Contatos feitos (${contatos.length})</h2>
          ${contatos.length ? `<ul class="linha-tempo">${contatos.map((c) => `
            <li>
              <strong>${dataBR(c.data_contato)}: ${esc(FORMA_CONTATO[c.forma])}</strong>${c.responsavel ? ` com ${esc(c.responsavel)}` : ''}<br>
              <span class="resultado-contato ${c.resultado}">${esc(RESULTADO_CONTATO[c.resultado])}</span>
              ${c.observacao ? `<div class="texto-livre" style="margin:.4rem 0 .2rem">${esc(c.observacao)}</div>` : ''}
              <span class="muted">Registrado por ${esc(c.usuario ? c.usuario.nome : '')}</span>
            </li>`).join('')}</ul>`
            : '<p class="muted">Nenhum contato registrado ainda.</p>'}
        </section>
      </div>`;

    $('#f-contato').addEventListener('submit', async (e) => {
      e.preventDefault();
      const b = $('button[type=submit]', e.target);
      b.disabled = true;
      try {
        ok(await sb.from('busca_ativa_contatos').insert({
          caso_id: id, data_contato: $('#ct-data').value, forma: $('#ct-forma').value,
          responsavel: $('#ct-resp').value.trim(), resultado: $('#ct-res').value, observacao: $('#ct-obs').value.trim(),
        }));
        toast('Contato registrado.');
        telaCasoBusca(id);
      } catch (err) { $('#ct-erro').textContent = erroPT(err); b.disabled = false; }
    });
    $('#cs-salvar').addEventListener('click', async () => {
      const nova = $('#cs-situacao').value;
      if (nova === caso.situacao) return;
      try {
        ok(await sb.from('busca_ativa_casos').update({ situacao: nova }).eq('id', id));
        toast('Situação do caso atualizada.');
        telaCasoBusca(id);
      } catch (err) {
        toast(/duplicate|unique/i.test(err.message) ? 'Este estudante já tem outro caso aberto. Use aquele.' : erroPT(err));
      }
    });
  }

  /* ================= Limpeza anual (somente Direção) ================= */
  function baixarArquivo(nome, conteudo, tipo) {
    const url = URL.createObjectURL(new Blob([conteudo], { type: tipo }));
    const a = document.createElement('a');
    a.href = url;
    a.download = nome;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  async function buscarTodas(ate, aoProgresso) {
    const lista = [];
    for (let de = 0; ; de += 1000) {
      const lote = ok(await sb.from('v_ocorrencias').select('*').lte('data_fato', ate)
        .order('data_fato').order('id').range(de, de + 999));
      lista.push(...lote);
      if (aoProgresso) aoProgresso(lista.length);
      if (lote.length < 1000) break;
    }
    return lista;
  }
  function planilhaCSV(lista) {
    const cel = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
    const cab = ['Nº', 'Data do fato', 'Turma', 'Estudante', 'Categoria', 'Tipo', 'Situação', 'Descrição do fato',
      'Providências', 'Registrado por', 'Função', 'Registrado em'];
    const linhas = lista.map((o) => [o.id, dataBR(o.data_fato), o.turma, o.aluno, o.categoria_nome || nomeCategoria(o.categoria),
      o.tipo_nome, STATUS[o.status], o.descricao, o.providencias, o.autor_nome, o.autor_funcao || '', dataHora(o.criado_em)].map(cel).join(';'));
    return '\ufeff' + [cab.map(cel).join(';'), ...linhas].join('\r\n');
  }

  async function telaLimpeza() {
    if (!ehDirecao()) throw new Error('Somente a Direção tem acesso a esta área.');
    const ano = new Date().getFullYear();
    const sugestao = new Date().getMonth() <= 2 ? `${ano - 1}-12-31` : hoje();
    let confirmadoEm = 0;
    let copiaFeita = false;
    let total = 0;

    conteudo.innerHTML = `
      <a class="voltar" href="#/configuracoes">&larr; Voltar para Configurações</a>
      <div class="cabecalho-pagina"><div><h1>Limpeza anual de ocorrências</h1>
        <p class="muted">Apaga de forma <strong>definitiva</strong> as ocorrências até a data escolhida, com conversas, linha do tempo, fotos e PDFs. Siga os 4 passos.</p></div></div>

      <fieldset class="etapa">
        <legend><span class="num">1</span> Até que data apagar</legend>
        <div class="grade-2">
          <div><label for="lp-ate">Apagar as ocorrências com data do fato até</label><input id="lp-ate" type="date" max="${hoje()}" value="${sugestao}"></div>
          <div style="align-self:end"><button class="btn sec" type="button" id="lp-contar">Ver quantas serão apagadas</button></div>
        </div>
        <p id="lp-resumo" class="resumo-limpeza muted">Escolha a data e clique em "Ver quantas serão apagadas".</p>
      </fieldset>

      <fieldset class="etapa">
        <legend><span class="num">2</span> Guarde uma cópia antes</legend>
        <p>Depois de apagar, não dá para recuperar. Baixe e guarde a cópia num lugar seguro da escola.</p>
        <div class="acoes" style="margin-top:.3rem">
          <button class="btn sec" type="button" id="lp-csv">Baixar planilha (abre no Excel)</button>
          <button class="btn sec" type="button" id="lp-pdf">Baixar relatório em PDF</button>
        </div>
        <p class="muted" id="lp-copia-status" style="margin-top:.6rem">O PDF de muitas ocorrências pode demorar alguns minutos. As fotos não entram na planilha: se alguma precisar ser guardada, gere o PDF da ocorrência antes.</p>
        <label class="check-grande"><input type="checkbox" id="lp-ok-copia"> Já baixei e guardei a cópia</label>
      </fieldset>

      <fieldset class="etapa">
        <legend><span class="num">3</span> Confirme que é você</legend>
        <p>Vamos enviar um código novo para <strong>${esc(eu.email)}</strong>. A confirmação vale 15 minutos.</p>
        <button class="btn sec" type="button" id="lp-enviar">Enviar código para meu e-mail</button>
        <div id="lp-codigo-box" class="oculto">
          <label for="lp-codigo">Código recebido</label>
          <div class="f-tipo-cat"><input id="lp-codigo" inputmode="numeric" maxlength="10" autocomplete="one-time-code">
          <button class="btn" type="button" id="lp-verificar">Confirmar código</button></div>
        </div>
        <p class="muted" id="lp-codigo-status" style="margin-top:.6rem"></p>
      </fieldset>

      <fieldset class="etapa etapa-perigo">
        <legend><span class="num">4</span> Apagar</legend>
        <label for="lp-palavra">Para confirmar, digite a palavra <strong>APAGAR</strong></label>
        <input id="lp-palavra" autocomplete="off" style="max-width:320px">
        <p class="erro" id="lp-erro" role="alert"></p>
        <button class="btn perigo-cheio grande" type="button" id="lp-apagar" disabled>Apagar ocorrências</button>
        <p class="muted" id="lp-progresso" style="margin-top:.8rem"></p>
      </fieldset>`;

    const ate = () => $('#lp-ate').value;
    const liberar = () => {
      const ok2 = total > 0 && copiaFeita && $('#lp-ok-copia').checked
        && Date.now() - confirmadoEm < 15 * 60 * 1000 && $('#lp-palavra').value.trim().toUpperCase() === 'APAGAR';
      $('#lp-apagar').disabled = !ok2;
      $('#lp-apagar').textContent = total ? `Apagar ${total} ocorrência(s)` : 'Apagar ocorrências';
    };
    const contar = async () => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ate())) { $('#lp-resumo').textContent = 'Escolha uma data.'; total = 0; liberar(); return; }
      const [oc, ax] = await Promise.all([
        sb.from('ocorrencias').select('id', { count: 'exact', head: true }).lte('data_fato', ate()),
        sb.from('anexos').select('id, ocorrencias!inner(data_fato)', { count: 'exact', head: true }).lte('ocorrencias.data_fato', ate()),
      ]);
      if (oc.error) throw oc.error;
      total = oc.count || 0;
      $('#lp-resumo').innerHTML = total
        ? `Serão apagadas <strong>${total}</strong> ocorrência(s) com data até <strong>${dataBR(ate())}</strong>, com <strong>${ax.count || 0}</strong> foto(s) ou PDF(s).`
        : `Não há ocorrências com data até ${dataBR(ate())}.`;
      $('#lp-resumo').classList.toggle('muted', !total);
      liberar();
    };
    $('#lp-contar').addEventListener('click', () => contar().catch((e) => toast(erroPT(e))));
    $('#lp-ate').addEventListener('change', () => { copiaFeita = false; $('#lp-ok-copia').checked = false; contar().catch((e) => toast(erroPT(e))); });

    $('#lp-csv').addEventListener('click', async () => {
      const b = $('#lp-csv');
      b.disabled = true;
      try {
        const lista = await buscarTodas(ate(), (n) => { b.textContent = `Preparando… ${n}`; });
        baixarArquivo(`ocorrencias-ate-${ate()}.csv`, planilhaCSV(lista), 'text/csv;charset=utf-8');
        copiaFeita = true;
        $('#lp-copia-status').textContent = `Planilha baixada com ${lista.length} ocorrência(s). Confira se ela abre antes de continuar.`;
        auditar('PDF_RELATORIO', null, null);
      } catch (e) { toast(erroPT(e)); }
      b.disabled = false;
      b.textContent = 'Baixar planilha (abre no Excel)';
      liberar();
    });
    $('#lp-pdf').addEventListener('click', async () => {
      const b = $('#lp-pdf');
      b.disabled = true;
      try {
        const lista = await buscarTodas(ate(), (n) => { b.textContent = `Preparando… ${n}`; });
        b.textContent = 'Montando o PDF…';
        await new Promise((res) => setTimeout(res, 50));
        window.EducaApoioPDF.relatorio(lista, `Cópia antes da limpeza anual: ocorrências até ${dataBR(ate())}`, escola, eu.nome);
        copiaFeita = true;
        $('#lp-copia-status').textContent = `Relatório em PDF baixado com ${lista.length} ocorrência(s).`;
        auditar('PDF_RELATORIO', null, null);
      } catch (e) { toast(erroPT(e)); }
      b.disabled = false;
      b.textContent = 'Baixar relatório em PDF';
      liberar();
    });
    $('#lp-ok-copia').addEventListener('change', () => {
      if ($('#lp-ok-copia').checked && !copiaFeita) {
        toast('Baixe a planilha ou o PDF antes de marcar.');
        $('#lp-ok-copia').checked = false;
      }
      liberar();
    });

    $('#lp-enviar').addEventListener('click', async () => {
      const r = await sb.auth.signInWithOtp({ email: eu.email, options: { shouldCreateUser: false } });
      if (r.error) { $('#lp-codigo-status').textContent = erroPT(r.error); return; }
      $('#lp-codigo-box').classList.remove('oculto');
      $('#lp-codigo-status').textContent = 'Código enviado. Confira seu e-mail (e a caixa de spam).';
      $('#lp-codigo').focus();
    });
    $('#lp-verificar').addEventListener('click', async () => {
      try {
        ok(await sb.auth.verifyOtp({ email: eu.email, token: $('#lp-codigo').value.replace(/\s/g, ''), type: 'email' }));
        confirmadoEm = Date.now();
        $('#lp-codigo-box').classList.add('oculto');
        $('#lp-codigo-status').innerHTML = '<strong style="color:var(--verde)">Identidade confirmada.</strong> Você tem 15 minutos para concluir.';
      } catch (e) { $('#lp-codigo-status').textContent = erroPT(e); }
      liberar();
    });
    $('#lp-palavra').addEventListener('input', liberar);

    $('#lp-apagar').addEventListener('click', async () => {
      if (!confirm(`ÚLTIMA CONFIRMAÇÃO\n\nApagar definitivamente ${total} ocorrência(s) com data até ${dataBR(ate())}?\n\nIsso não pode ser desfeito.`)) return;
      const b = $('#lp-apagar');
      const prog = $('#lp-progresso');
      b.disabled = true;
      $('#lp-erro').textContent = '';
      try {
        // 1. Fotos e PDFs
        const caminhos = [];
        for (let de = 0; ; de += 1000) {
          const lote = ok(await sb.from('anexos').select('caminho, ocorrencias!inner(data_fato)')
            .lte('ocorrencias.data_fato', ate()).order('id').range(de, de + 999));
          caminhos.push(...lote.map((a) => a.caminho));
          if (lote.length < 1000) break;
        }
        for (let i = 0; i < caminhos.length; i += 100) {
          prog.textContent = `Apagando fotos e PDFs: ${Math.min(i + 100, caminhos.length)} de ${caminhos.length}…`;
          const rem = await sb.storage.from('anexos').remove(caminhos.slice(i, i + 100));
          if (rem.error) throw new Error(erroPT(rem.error));
        }
        // 2. Ocorrências, em lotes
        let apagadas = 0;
        for (;;) {
          const n = ok(await sb.rpc('limpar_ocorrencias', { p_ate: ate(), p_confirmacao: 'APAGAR', p_limite: 500 }));
          apagadas += n;
          prog.textContent = `Apagando ocorrências: ${apagadas} de ${total}…`;
          if (!n) break;
        }
        prog.innerHTML = `<strong style="color:var(--verde)">Pronto: ${apagadas} ocorrência(s) apagada(s).</strong> A limpeza ficou registrada na Auditoria.`;
        total = 0;
        $('#lp-palavra').value = '';
        toast('Limpeza anual concluída.');
        carregarNotificacoes();
      } catch (e) {
        $('#lp-erro').textContent = erroPT(e) + ' O que já foi apagado não volta; você pode clicar de novo para continuar.';
        b.disabled = false;
      }
      liberar();
    });

    contar().catch((e) => toast(erroPT(e)));
  }

  /* ================= Auditoria (Direção) ================= */
  const ACOES = ['LOGIN', 'LOGOUT', 'OCORRENCIA_CRIADA', 'OCORRENCIA_VISUALIZADA', 'OCORRENCIA_ATUALIZADA', 'MENSAGEM_ENVIADA',
    'PDF_OCORRENCIA', 'PDF_RELATORIO', 'SAIR_DE_TODOS', 'ANEXO_ADICIONADO', 'ANEXO_ABERTO', 'ANEXO_REMOVIDO', 'OCORRENCIA_EDITADA', 'OCORRENCIA_EXCLUIDA', 'TURMA_ALTERADA', 'ALERTA_FALTAS', 'NOME_ALTERADO', 'BUSCA_ATIVA_CASO', 'BUSCA_ATIVA_CONTATO', 'BUSCA_ATIVA_ACESSO_LIBERADO', 'BUSCA_ATIVA_ACESSO_REMOVIDO', 'LIMPEZA_OCORRENCIAS', 'CATEGORIA_CRIADA', 'CATEGORIA_ALTERADA',
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
  async function telaConta(p) {
    conteudo.innerHTML = `
      <div class="cabecalho-pagina"><div><h1>Minha conta</h1></div></div>
      <section class="folha" style="max-width:560px">
        <form id="f-nome">
          <label for="mc-nome">Seu nome</label>
          <div class="f-tipo-cat">
            <input id="mc-nome" name="nome" maxlength="120" required value="${esc(eu.nome)}" autocomplete="name">
            <button class="btn" type="submit">Salvar nome</button>
          </div>
          <p class="muted" style="margin-top:.5rem">É o nome que aparece nas ocorrências, nas conversas e nos PDFs.</p>
          <p class="erro" id="mc-erro" role="alert"></p>
        </form>
        <div class="dados" style="margin-top:.6rem"><dl>
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
    $('#f-nome').addEventListener('submit', async (e) => {
      e.preventDefault();
      const novo = $('#mc-nome').value.trim().replace(/\s+/g, ' ');
      $('#mc-erro').textContent = '';
      if (novo === eu.nome) { $('#mc-erro').textContent = 'Nada foi alterado.'; return; }
      const b = $('button[type=submit]', e.target);
      b.disabled = true;
      try {
        ok(await sb.rpc('alterar_meu_nome', { p_nome: novo }));
        eu.nome = novo;
        $('#nome-usuario').textContent = novo;
        toast('Nome alterado.');
      } catch (err) {
        $('#mc-erro').textContent = /alterar_meu_nome/.test(err.message)
          ? 'Falta ativar esta opção no banco: rode o arquivo migracao-alterar-nome.sql no Supabase.'
          : erroPT(err);
      }
      b.disabled = false;
    });
    if (p && p.editar === 'nome') { $('#mc-nome').focus(); $('#mc-nome').select(); }

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

  /* ================= Inicialização ================= */
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
