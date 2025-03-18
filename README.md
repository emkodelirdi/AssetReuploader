# ImageReuploader

Do you: 

- Have a lot of free marketplace image assets that you don't own and you want to use EditableImage?
- Want to easily migrate all of your image assets from one creator to another?

ImageReuploader is a simple Node.js tool for reuploading and replacing images in your game through Roblox's Open Cloud


https://github.com/user-attachments/assets/d79b3754-bd43-4e3f-adf7-7a13f5cfebe7


When you hit search, it'll search for all assets under the selected instance or the datamodel(depending on your setting) that contains one of the selected image content properties

![image](https://github.com/user-attachments/assets/e3a6f01b-2d3c-4bfb-87ba-30468a9b13ed)

It'll only consider images that the target creator(your profile or chosen group) doesn't already own

Then, when you hit Run, 

![image](https://github.com/user-attachments/assets/c21a4468-e219-4bfc-8bef-6be72f203ac0)

The node.js program should take care of the rest!

The node.js program works in 3 phases

- Downloads the assets
- Reuploads the assets under the target creator
- Sends the results back to roblox

The roblox plugin then replaces all occurrences of those assetIDs in the game with the new ones!


- ### If any assets were moderated, it'll spit them out into a folder in the workspace for you so you can handle their reuploads manually if need be

# Setup

- Head over to releases and grab the latest release https://github.com/TylerAtStarboard/ImageReuploader/releases/
  
- Drag ImageReuploader.rbxmx into a studio place, and right click -> Save as Local Plugin
  ![image](https://github.com/user-attachments/assets/4d0701e8-90d8-4c12-8566-987ebf38eeee)

- Head to the Creator Dashboard https://create.roblox.com/dashboard/

- Navigate to Open Cloud for the creator you want to upload to(your profile or a group)
  
![image](https://github.com/user-attachments/assets/9d70d46b-c485-43f0-8916-8115bc6032f0)

- Create a new API key

- Make sure your settings look like this, add your IP(or 0.0.0.0/0 if you don't care), and generate a new API Key

![image](https://github.com/user-attachments/assets/f536711d-c53d-4452-aabf-f38c3734fc35)

- Copy the full API key and then open up the plugin and paste it in the API Key field

  ![image](https://github.com/user-attachments/assets/55105aff-a8a2-48c5-93ae-6bc271f56e6d)

- Make sure this is the correct API key for the group you have selected, or for your profile if Upload To Group is turned off

- Run ImageUploader.exe to start the program, and then you're good to go!

![image](https://github.com/user-attachments/assets/a4b8bc18-fbce-4574-bd1f-602a1526a688)

# Building from Source

- Install node.js
- Navigate to the project directory and open the terminal
- Enter these commands
- npm install -g pkg
- npm run build-exe

# Notes

- The conversion process can take several minutes for hundreds of assets. There are some long delays to avoid hitting OpenCloud rate limits.
So relax and grab a coffee!

- This is the first real distributed tool/software I've ever made. It was a quick tool made for my studio that I decided to share with you all.
- (so there might be issues and I'm a busy person working on my games so I might not be able to maintain this very quickly)



