'''
Class Emotion
This class is mainly a data structure to store an emotion with its intensity
Params:
* name: The string ref of the emotion
* intensity: The intensity at which the emotion is set upon construction.
'''
class Emotion:
    def __init__(self, name, intensity):
        self.name = name
        self.intensity = intensity