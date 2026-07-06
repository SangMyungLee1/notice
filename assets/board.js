(function(){
  'use strict';

  var list, pagination, empty, form, input;
  var boardFilter = 'all';
  var pageBase = '/';
  var perPage = 10;
  var currentPage = 1;
  var currentQuery = '';
  var allPosts = [];
  var boards = [];
  var liveTimer = null;

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function(ch) {
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch] || ch;
    });
  }

  function displayDate(value) {
    var d = new Date(value);
    if (isNaN(d.getTime())) return String(value || '').slice(0, 10).replace(/-/g,'.');
    return d.getFullYear() + '.' + String(d.getMonth()+1).padStart(2,'0') + '.' + String(d.getDate()).padStart(2,'0');
  }

  function normalize(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/[~!@#$%^&*()_+={}\[\]|\\:;"'<>,.?/`·ㆍ，。！？、\-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function compact(value) {
    return normalize(value).replace(/\s+/g, '');
  }

  function boardInfo(slug) {
    slug = slug || 'free';
    for (var i=0; i<boards.length; i++) {
      if (boards[i] && boards[i].slug === slug) return boards[i];
    }
    return {};
  }

  function makeSearchText(post) {
    var b = boardInfo(post.board || 'free');
    return [
      post && post.id,
      post && post.title,
      post && post.excerpt,
      post && post.searchText,
      post && post.boardName,
      post && post.board,
      post && post.path,
      b.name,
      b.description,
      b.path
    ].join(' ');
  }

  function queryMatches(post, query) {
    var q = normalize(query);
    if (!q) return true;
    var target = normalize(makeSearchText(post));
    var targetCompact = target.replace(/\s+/g, '');
    var qCompact = q.replace(/\s+/g, '');
    if (target.indexOf(q) !== -1) return true;
    if (qCompact && targetCompact.indexOf(qCompact) !== -1) return true;
    var tokens = q.split(' ').filter(Boolean);
    if (!tokens.length) return true;
    return tokens.every(function(token){
      return target.indexOf(token) !== -1 || targetCompact.indexOf(compact(token)) !== -1;
    });
  }

  function sortPosts(rows) {
    return rows.slice().sort(function(a,b){
      var aid = Number(a && a.id) || 0;
      var bid = Number(b && b.id) || 0;
      if (aid !== bid) return bid - aid;
      return new Date((b && b.createdAt) || 0) - new Date((a && a.createdAt) || 0);
    });
  }

  function mergePendingPosts(basePosts) {
    var base = Array.isArray(basePosts) ? basePosts.slice() : [];
    var keys = {};
    base.forEach(function(post){ if(post) keys[String(post.id || post.path)] = true; });
    var pending = [];
    try {
      pending = JSON.parse(localStorage.getItem('notice_pending_posts') || '[]');
      if(!Array.isArray(pending)) pending=[];
    } catch(_) { pending=[]; }
    var now = Date.now();
    var keep = [];
    pending.forEach(function(post){
      if(!post || !post.path) return;
      var key = String(post.id || post.path);
      var savedAt = Number(post.savedAtMs || 0);
      if(savedAt && now - savedAt > 24*60*60*1000) return;
      if(keys[key]) return;
      keys[key] = true;
      keep.push(post);
      base.unshift(post);
    });
    try {
      if (keep.length) localStorage.setItem('notice_pending_posts', JSON.stringify(keep.slice(0,20)));
      else localStorage.removeItem('notice_pending_posts');
    } catch(_) {}
    return sortPosts(base);
  }

  function visiblePosts() {
    var rows = Array.isArray(allPosts) ? allPosts.slice() : [];
    if (boardFilter !== 'all') {
      rows = rows.filter(function(post){ return ((post && post.board) || 'free') === boardFilter; });
    }
    if (currentQuery) {
      rows = rows.filter(function(post){ return queryMatches(post, currentQuery); });
    }
    return sortPosts(rows);
  }

  function renderRows(rows) {
    if(!list) return;
    if(!rows.length) {
      list.innerHTML = '';
      if(empty) empty.classList.add('active');
      return;
    }
    if(empty) empty.classList.remove('active');
    list.innerHTML = rows.map(function(post){
      var href = String((post && post.path) || '').replace(/^\/+/, '');
      return '<div class="board-row">' +
        '<div class="board-no">' + escapeHtml(post && post.id) + '</div>' +
        '<a class="board-title" href="/' + escapeHtml(href) + '">' + escapeHtml(post && post.title) + '</a>' +
        '<div class="board-date">' + displayDate(post && post.createdAt) + '</div>' +
      '</div>';
    }).join('');
  }

  function pageButton(label,page,active,disabled){
    var btn=document.createElement('button');
    btn.type='button';
    btn.className='page-btn'+(active?' active':'');
    btn.textContent=label;
    btn.disabled=!!disabled;
    if(!disabled) btn.addEventListener('click', function(){ currentPage=page; render(true); });
    return btn;
  }

  function renderPagination(totalPages){
    if(!pagination) return;
    pagination.innerHTML='';
    if(totalPages<=1) return;
    var blockStart=Math.floor((currentPage-1)/10)*10+1;
    var blockEnd=Math.min(blockStart+9,totalPages);
    pagination.appendChild(pageButton('‹',Math.max(1,blockStart-10),false,blockStart===1));
    for(var i=blockStart;i<=blockEnd;i++) pagination.appendChild(pageButton(String(i),i,i===currentPage,false));
    pagination.appendChild(pageButton('›',Math.min(totalPages,blockStart+10),false,blockEnd>=totalPages));
  }

  function updateUrl(){
    try {
      var params=new URLSearchParams();
      if(currentQuery) params.set('q',currentQuery);
      if(currentPage>1) params.set('page',String(currentPage));
      var qs=params.toString();
      history.replaceState({q:currentQuery,page:currentPage},'',qs ? pageBase + '?' + qs : pageBase);
    } catch(_) {}
  }

  function render(syncUrl){
    if(!list) return;
    var rows=visiblePosts();
    var totalPages=Math.max(1,Math.ceil(rows.length/perPage));
    currentPage=Math.max(1,Math.min(currentPage,totalPages));
    var start=(currentPage-1)*perPage;
    renderRows(rows.slice(start,start+perPage));
    renderPagination(totalPages);
    if(syncUrl) updateUrl();
  }

  function setQuery(value, syncUrl) {
    currentQuery = String(value || '').trim();
    currentPage = 1;
    if(input && input.value !== currentQuery) input.value = currentQuery;
    render(syncUrl !== false);
  }

  function loadFromUrl(){
    try {
      var params=new URLSearchParams(location.search);
      currentQuery=params.get('q')||'';
      currentPage=Math.max(1,parseInt(params.get('page')||'1',10)||1);
    } catch(_) {
      currentQuery='';
      currentPage=1;
    }
    if(input) input.value=currentQuery;
    render(false);
  }

  function bindSearchEvents(){
    if(form) {
      form.addEventListener('submit', function(event){
        event.preventDefault();
        setQuery(input ? input.value : '', true);
      });
    }
    if(input) {
      input.addEventListener('input', function(){
        clearTimeout(liveTimer);
        liveTimer = setTimeout(function(){
          setQuery(input.value, true);
        }, 120);
      });
      input.addEventListener('keydown', function(event){
        if(event.key === 'Enter') {
          event.preventDefault();
          clearTimeout(liveTimer);
          setQuery(input.value, true);
        }
      });
    }
  }

  function bootFetch(){
    fetch('/data/posts.json?ts=' + Date.now(), {cache:'no-store'})
      .then(function(res){ return res.ok ? res.json() : null; })
      .then(function(rows){
        if(Array.isArray(rows) && rows.length) {
          allPosts = mergePendingPosts(rows);
          render(false);
        }
      })
      .catch(function(){});
    fetch('/data/boards.json?ts=' + Date.now(), {cache:'no-store'})
      .then(function(res){ return res.ok ? res.json() : null; })
      .then(function(rows){
        if(Array.isArray(rows) && rows.length) {
          boards = rows;
          render(false);
        }
      })
      .catch(function(){});
  }

  ready(function(){
    list = document.getElementById('boardList');
    pagination = document.getElementById('boardPagination');
    empty = document.getElementById('boardEmpty');
    form = document.getElementById('boardSearchForm');
    input = document.getElementById('boardSearchInput');
    boardFilter = window.NOTICE_BOARD_FILTER || 'all';
    pageBase = window.NOTICE_PAGE_BASE || location.pathname || '/';
    perPage = Number(window.NOTICE_PER_PAGE || 10) || 10;
    allPosts = mergePendingPosts(Array.isArray(window.NOTICE_POSTS) ? window.NOTICE_POSTS : []);
    boards = Array.isArray(window.NOTICE_BOARDS) ? window.NOTICE_BOARDS : [];
    bindSearchEvents();
    loadFromUrl();
    bootFetch();
    window.addEventListener('popstate', loadFromUrl);
    window.noticeBoardSearch = { search: function(q){ setQuery(q, true); }, render: render };
  });
})();
