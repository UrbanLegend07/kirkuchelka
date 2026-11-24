/**
 * Draws the Connect Four board into a container element.
 *
 * The board is 7 column buttons, each with 6 cells (top to bottom).
 * Clicking anywhere in a column = dropping a disc into that column.
 * The newest disc gets a short "falling" animation, winning discs are highlighted.
 */

let lastAnimatedMoveKey = null;

/**
 * @param {HTMLElement} boardElement
 * @param {object} options
 * @param {(string|null)[][]} options.board  board[row][column], row 0 = top
 * @param {boolean} options.canMove           is it the player's turn (columns clickable)
 * @param {string|null} options.yourColor     "RED" / "YELLOW", used for the hover preview
 * @param {object|null} options.lastMove      { row, column } of the newest disc
 * @param {{row:number, column:number}[]} options.winningCells
 * @param {(column:number) => void} options.onColumnClick
 */
export function renderBoard(boardElement, { board, canMove, yourColor, lastMove, winningCells = [], onColumnClick }) {
  const rowCount = board.length;
  const columnCount = board[0].length;
  const winningCellKeys = new Set(winningCells.map((cell) => cellKey(cell.row, cell.column)));

  // Animate a disc only the first time we see it, not on every redraw.
  const lastMoveKey = lastMove ? `${lastMove.row}:${lastMove.column}:${lastMove.color}` : null;
  const shouldAnimateLastMove = lastMoveKey !== null && lastMoveKey !== lastAnimatedMoveKey;
  lastAnimatedMoveKey = lastMoveKey;

  boardElement.replaceChildren();
  boardElement.dataset.previewColor = (yourColor ?? '').toLowerCase();

  for (let column = 0; column < columnCount; column++) {
    const isColumnFull = board[0][column] !== null;

    const columnButton = document.createElement('button');
    columnButton.type = 'button';
    columnButton.className = 'board-column';
    columnButton.disabled = !canMove || isColumnFull;
    columnButton.setAttribute('aria-label', `Column ${column + 1}${isColumnFull ? ' (full)' : ''}`);
    columnButton.addEventListener('click', () => onColumnClick(column));

    for (let row = 0; row < rowCount; row++) {
      const cellElement = document.createElement('div');
      cellElement.className = 'cell';

      const discColor = board[row][column];
      if (discColor) {
        const discElement = document.createElement('div');
        discElement.className = `disc disc-${discColor.toLowerCase()}`;

        if (winningCellKeys.has(cellKey(row, column))) {
          discElement.classList.add('winning');
        }
        const isLastMove = lastMove && lastMove.row === row && lastMove.column === column;
        if (isLastMove) {
          discElement.classList.add('last-move');
          if (shouldAnimateLastMove) {
            // The disc falls from above the board: the lower the row, the longer the fall.
            discElement.style.setProperty('--fall-rows', String(row + 1));
            discElement.classList.add('falling');
          }
        }
        cellElement.append(discElement);
      }
      columnButton.append(cellElement);
    }
    boardElement.append(columnButton);
  }
}

/** Forget the last animated move, so the first disc of a new game animates again. */
export function resetBoardAnimation() {
  lastAnimatedMoveKey = null;
}

function cellKey(row, column) {
  return `${row}:${column}`;
}
