# Install Imposer in Adobe Acrobat

Needs **Acrobat Pro or Standard** (not the free Reader — Reader cannot create or change pages).

1. Close Acrobat.
2. Copy `Imposer.js` into Acrobat's user **JavaScripts** folder (create the folder if it is missing):
   - **Windows:** `%APPDATA%\Adobe\Acrobat\DC\JavaScripts`
     (paste that into the File Explorer address bar)
   - **Mac:** `~/Library/Application Support/Adobe/Acrobat/DC/JavaScripts`
     (Finder > Go > Go to Folder…)
3. Start Acrobat. Check that *Preferences > JavaScript > Enable Acrobat JavaScript* is ticked.
4. Open a PDF. The commands are under **Edit > Imposer**
   (in the new Acrobat look: the ☰ Menu, then Edit, or under Plug-ins).

Not sure where the folder is? In Acrobat press Ctrl+J (Cmd+J), type
`app.getPath("user","javascript")`, and press Ctrl+Enter — it prints the folder.

## Using it

- **Save your PDF first.** Booklet, N-up and the other layout commands read pages from the saved file.
- Layout commands open the result as a **new document**; your original is untouched.
  Commands marked "Changes this document" edit the open PDF — use *File > Revert* or close without saving to undo.
- All sizes are in millimetres.
- **Sequences:** run the commands you need once, then *Imposer > Save my steps as a sequence*.
  Next time: *Imposer > Run a saved sequence*.

## Remove

Delete `Imposer.js` from that folder and restart Acrobat.
