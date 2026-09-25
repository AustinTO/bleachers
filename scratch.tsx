const cors = (response: Response, request?: Request) => {
  const headers = new Headers(response.headers);
  const origin = request?.headers.get('origin') || '*';
  headers.set('access-control-allow-origin', origin);
  if (origin !== '*') headers.set('access-control-allow-credentials', 'true');
  headers.set('access-control-allow-methods', 'GET,POST,OPTIONS');
  headers.set('access-control-allow-headers', 'content-type, authorization, x-capture-start-ms, x-capture-end-ms, x-user-id');
  return new Response(response.body, { status: response.status, headers });
};
