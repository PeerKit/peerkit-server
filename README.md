### Connection process

Response peer:

- Connects to PKS with WebSocket
- Sends 'CONN' messages to queue up offers
- Sends 'RESOURCE' message to indicate available resources


Request peer:
- Connects to PKS with WebSocket
- Sends JSONP request to '/resource' with '?url=x&url=y' etc.
- Sends DC answer and ice with 'RESPONSE' message
