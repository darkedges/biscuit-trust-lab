export function tokens(text, language = 'json') {
  const pattern = language === 'json'
    ? /"(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g
    : /'(?:''|[^'])*'|"(?:\\.|[^"\\])*"|--[\w-]+|\b(?:curl(?:\.exe)?)\b|\$\w+/g;
  const parts = []; let position = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > position) parts.push({ text: text.slice(position, match.index), kind: '' });
    const value = match[0];
    const kind = language === 'json'
      ? value[0] === '"' ? (/^\s*:/.test(text.slice(match.index + value.length)) ? 'key' : 'string') : /^(true|false|null)$/.test(value) ? 'literal' : 'number'
      : value.startsWith('--') ? 'key' : value.startsWith('curl') ? 'literal' : 'string';
    parts.push({ text: value, kind }); position = match.index + value.length;
  }
  if (position < text.length) parts.push({ text: text.slice(position), kind: '' });
  return parts;
}

export function curlCommand(request, shell = 'bash') {
  const quote = shell === 'powershell' ? value => `'${value.replaceAll("'", "''")}'` : value => `'${value.replaceAll("'", "'\"'\"'")}'`;
  const headers = Object.entries(request.headers).map(([key, value]) => `--header ${quote(`${key}: ${value}`)}`);
  if (shell === 'powershell') {
    return `$body = ${quote(request.body)}\n$body | curl.exe --request ${request.method} ${quote(request.url)} ${headers.join(' ')} --data-binary '@-'`;
  }
  return [`curl --request ${request.method} ${quote(request.url)}`, ...headers, `--data-raw ${quote(request.body)}`].join(' \\\n  ');
}
