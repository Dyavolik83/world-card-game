# world-card-game

A simple browser game inspired by *The World Game* geography card game.

**Play online:** https://dyavolik83.github.io/world-card-game/

## How it works
- You play against the computer (**YOU** vs **SOMEONE ELSE**).
- You see your country card. The opponent card is hidden.
- Choose one category on your card (Area / Population / Highest point / Neighbors).
- The opponent card is revealed for 2 seconds, then the values are compared.
- Bigger value wins and takes both cards.
- If there is a tie, both cards go to the **pot**. Next winner takes all pot cards too.
- The world map is colored: **Blue = YOU**, **Red = SOMEONE ELSE**.

## Data
- Country stats are stored offline in `data/stats.json`.
- Highest point values are based on Wikipedia’s *List of elevation extremes by country*.
- World map borders are loaded from `data/map.geojson` (offline).

## For school use
This project was created for a school PYP Exhibition about videogames as learning and decision-making systems.
