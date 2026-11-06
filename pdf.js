// Geração de PDFs no navegador com jsPDF (fontes padrão aceitam acentuação em português)
window.SisRoePDF = (function () {
  const STATUS = { ABERTA: 'Aberta', EM_ACOMPANHAMENTO: 'Em acompanhamento', ENCERRADA: 'Encerrada' };
  const CATEGORIA = { ADMINISTRATIVA: 'Administrativa', PEDAGOGICA: 'Pedagógica', CONVIVA: 'Protocolo Conviva (média gravidade)' };

  const L = 595.28, A = 841.89, M = 50, LARG = L - 2 * M, BASE = A - 60;
  const dataBR = (d) => (d ? d.split('-').reverse().join('/') : '');
  const dataHora = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '');

  function criar(titulo, escola) {
    const doc = new window.jspdf.jsPDF({ unit: 'pt', format: 'a4' });
    doc.setProperties({ title: titulo });
    let y = M;

    function texto(t, o = {}) {
      const tam = o.tam || 10;
      doc.setFont('helvetica', o.negrito ? 'bold' : 'normal');
      doc.setFontSize(tam);
      doc.setTextColor(o.cor || '#000000');
      const linhas = doc.splitTextToSize(String(t == null ? '-' : t), LARG);
      const alt = tam * 1.35;
      linhas.forEach((l) => {
        if (y + alt > BASE) { doc.addPage(); y = M; }
        if (o.centro) doc.text(l, L / 2, y, { align: 'center' });
        else doc.text(l, M, y);
        y += alt;
      });
    }
    const espaco = (n) => { y += n; if (y > BASE) { doc.addPage(); y = M; } };
    const linha = () => { doc.setDrawColor(140); doc.setLineWidth(0.5); doc.line(M, y, L - M, y); y += 8; };
    const precisa = (alt) => { if (y + alt > BASE) { doc.addPage(); y = M; } };

    texto(escola.escola_nome, { tam: 13, negrito: true, centro: true });
    if (escola.escola_endereco) texto(escola.escola_endereco, { tam: 9, centro: true });
    espaco(6);
    texto(titulo, { tam: 12, negrito: true, centro: true });
    espaco(2);
    linha();
    espaco(4);

    function finalizar(nomeArquivo, geradoPor) {
      const total = doc.getNumberOfPages();
      for (let i = 1; i <= total; i++) {
        doc.setPage(i);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.setTextColor('#555555');
        const rod = `Gerado pelo SisRoe em ${new Date().toLocaleString('pt-BR')} por ${geradoPor}. Página ${i} de ${total}. Documento com dados de estudantes: uso restrito (LGPD).`;
        doc.text(doc.splitTextToSize(rod, LARG), L / 2, A - 35, { align: 'center' });
      }
      doc.save(nomeArquivo);
    }

    return { doc, texto, espaco, linha, precisa, finalizar, getY: () => y, setY: (v) => { y = v; } };
  }

  function ficha(oc, historico, escola, geradoPor) {
    const p = criar(`Registro de Ocorrência nº ${oc.id}`, escola);
    p.texto(`Data do fato: ${dataBR(oc.data_fato)}`);
    p.texto(`Estudante: ${oc.aluno}`, { negrito: true });
    p.texto(`Turma: ${oc.turma}`);
    p.texto(`Categoria: ${CATEGORIA[oc.categoria]}`);
    p.texto(`Tipo de ocorrência: ${oc.tipo_nome}`);
    p.texto(`Situação: ${STATUS[oc.status]}`);
    p.texto(`Registrado por: ${oc.autor_nome}${oc.autor_funcao ? ` (${oc.autor_funcao})` : ''} em ${dataHora(oc.criado_em)}`);
    p.espaco(8);
    p.texto('Descrição do fato', { negrito: true });
    p.texto(oc.descricao);
    p.espaco(8);
    p.texto('Providências adotadas', { negrito: true });
    p.texto(oc.providencias);

    if (historico.length) {
      p.espaco(10);
      p.texto('Acompanhamento', { negrito: true });
      historico.forEach((h) => {
        p.texto(`${dataHora(h.criado_em)}  ${STATUS[h.status]} (${h.usuario ? h.usuario.nome : ''})${h.observacao ? ': ' + h.observacao : ''}`, { tam: 9 });
      });
    }

    // Assinaturas
    p.espaco(40);
    p.precisa(150);
    const d = p.doc;
    let y = p.getY();
    ['Responsável pelo registro', 'Coordenação', 'Direção', 'Responsável pelo estudante (ciência)'].forEach((rot, i) => {
      const x = i % 2 === 0 ? 60 : 310;
      if (i === 2) y += 60;
      d.setDrawColor(0); d.setLineWidth(0.5);
      d.line(x, y, x + 220, y);
      d.setFont('helvetica', 'normal'); d.setFontSize(9); d.setTextColor('#000000');
      d.text(rot, x + 110, y + 12, { align: 'center' });
    });
    p.setY(y + 30);

    p.finalizar(`ocorrencia-${oc.id}.pdf`, geradoPor);
  }

  function relatorio(lista, filtrosTexto, escola, geradoPor) {
    const p = criar('Relatório de Ocorrências', escola);
    p.texto(filtrosTexto, { tam: 9, cor: '#333333' });
    p.espaco(4);
    const c = { ABERTA: 0, EM_ACOMPANHAMENTO: 0, ENCERRADA: 0 };
    lista.forEach((o) => { c[o.status]++; });
    p.texto(`Total: ${lista.length}   Abertas: ${c.ABERTA}   Em acompanhamento: ${c.EM_ACOMPANHAMENTO}   Encerradas: ${c.ENCERRADA}`, { negrito: true });
    p.espaco(4);
    p.linha();
    if (!lista.length) p.texto('Nenhuma ocorrência encontrada com esses filtros.');
    lista.forEach((o) => {
      p.precisa(70);
      p.texto(`Nº ${o.id}  ${dataBR(o.data_fato)}  ${o.aluno} (${o.turma})`, { negrito: true });
      p.texto(`${CATEGORIA[o.categoria]} / ${o.tipo_nome}   Situação: ${STATUS[o.status]}   Registro: ${o.autor_nome}`, { tam: 9 });
      p.texto(`Fato: ${o.descricao}`, { tam: 9 });
      p.texto(`Providências: ${o.providencias}`, { tam: 9 });
      p.espaco(2);
      p.linha();
    });
    p.finalizar('relatorio-ocorrencias.pdf', geradoPor);
  }

  return { ficha, relatorio };
})();
